import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ensureQueueExists } from "./deploy-with-vapid.mjs";
import { isWorkersBuild } from "./prepare-cloudflare-build.mjs";

const queueName = "taiwan-fin-hub-sync";
const missingQueue = {
  exitCode: 1,
  stdout: "",
  stderr: `Queue "${queueName}" does not exist.`,
};

test("only prepares resources inside Cloudflare Workers Builds", () => {
  assert.equal(isWorkersBuild({ WORKERS_CI: "1" }), true);
  assert.equal(isWorkersBuild({ WORKERS_CI: undefined }), false);
});

test("Cloudflare build token reaches resource preparation, migrations and deployment without printing the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-build-auth-"));
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const execute = promisify(execFile);
  const newToken = "synthetic token with spaces $() `quotes`";
  const cases = [
    {
      existing: newToken,
      expected: newToken,
    },
    { existing: "original-build-token", expected: "original-build-token" },
    {},
  ];
  const fixture = `#!${process.execPath}
import { basename } from "node:path";
console.log(JSON.stringify({
  command: basename(process.argv[1]),
  args: process.argv.slice(2),
  authorized: process.env.CLOUDFLARE_API_TOKEN === process.env.EXPECTED_TOKEN
}));
`;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    for (const name of ["node", "npm"]) {
      await writeFile(join(directory, name), fixture, { mode: 0o700 });
    }
    for (const tokenCase of cases) {
      for (const name of ["prebuild", "deploy"]) {
        const { stdout, stderr } = await execute(
          "/bin/sh",
          ["-c", scripts[name]],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              CLOUDFLARE_API_TOKEN: tokenCase.existing,
              EXPECTED_TOKEN: tokenCase.expected,
            },
          },
        );
        const calls = stdout.trim().split("\n").map(JSON.parse);
        assert.ok(
          calls.every((call) => call.authorized),
          `${name}: wrong token`,
        );
        assert.deepEqual(
          calls.map(({ command, args }) => ({ command, args })),
          name === "prebuild"
            ? [
                {
                  command: "node",
                  args: ["scripts/prepare-cloudflare-build.mjs"],
                },
              ]
            : [
                { command: "npm", args: ["run", "db:migrate:remote"] },
                { command: "node", args: ["scripts/deploy-with-vapid.mjs"] },
              ],
        );
        assert.ok(!`${stdout}${stderr}`.includes(newToken));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runner(results, calls) {
  return async (argumentsToRun, options) => {
    calls.push({ argumentsToRun, options });
    const result = results.shift();
    assert.ok(result, "Unexpected Wrangler invocation");
    return result;
  };
}

test("keeps an existing Queue", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    ["--config", "wrangler.toml"],
    runner([{ exitCode: 0, stdout: "Queue Name", stderr: "" }], calls),
  );

  assert.deepEqual(
    calls.map((call) => call.argumentsToRun),
    [["queues", "info", queueName, "--config", "wrangler.toml"]],
  );
});

test("creates a missing Queue", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    [],
    runner(
      [missingQueue, { exitCode: 0, stdout: "Created", stderr: "" }],
      calls,
    ),
  );

  assert.deepEqual(
    calls.map((call) => call.argumentsToRun),
    [
      ["queues", "info", queueName],
      ["queues", "create", queueName],
    ],
  );
});

test("accepts a Queue created by a concurrent build", async () => {
  const calls = [];
  await ensureQueueExists(
    queueName,
    [],
    runner(
      [
        missingQueue,
        { exitCode: 1, stdout: "", stderr: "already exists" },
        { exitCode: 0, stdout: "Queue Name", stderr: "" },
      ],
      calls,
    ),
  );

  assert.equal(calls.length, 3);
});

test("reports a Queue creation failure", async () => {
  const calls = [];
  await assert.rejects(
    ensureQueueExists(
      queueName,
      [],
      runner(
        [
          missingQueue,
          { exitCode: 1, stdout: "", stderr: "permission denied" },
          missingQueue,
        ],
        calls,
      ),
    ),
    /Unable to create Queue.*permission denied/s,
  );
});
