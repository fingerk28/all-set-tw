import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  discoverAccessSecrets,
  needsAccessSetup,
} from "./cloudflare-access.mjs";
import { deploy, readDeploymentConfig } from "./deploy-with-vapid.mjs";

const accountId = "test-account";
const workerName = "taiwan-fin-hub";
const config = { name: workerName, vars: {} };
const environment = {
  WORKERS_CI: "1",
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "test-build-token",
};
const accessSecrets = {
  TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  POLICY_AUD: "worker-application-audience",
};
const vapidSecrets = {
  VAPID_PUBLIC_KEY: "existing-public",
  VAPID_PRIVATE_KEY: "existing-private",
};
const workerUrl = `https://${workerName}.test-subdomain.workers.dev/`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "metadata-key",
  alg: "RS256",
};

function signedMetadata(extra = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: publicJwk.kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      type: "match",
      hostname: new URL(workerUrl).hostname,
      auth_domain: new URL(accessSecrets.TEAM_DOMAIN).hostname,
      aud: accessSecrets.POLICY_AUD,
      iat: Math.floor(Date.now() / 1000),
      ...extra,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}

function publicAccess({
  metadata = signedMetadata(),
  missingResponses = 0,
  url: applicationUrl = workerUrl,
} = {}) {
  const calls = [];
  let heads = 0;
  const fetchPublic = async (url, options) => {
    calls.push(url);
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    assert.equal(options.redirect, "manual");
    if (url === applicationUrl) {
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers["cf-access-metadata-request"], "true");
      heads += 1;
      return new Response(null, {
        status: 200,
        headers:
          heads <= missingResponses || !metadata
            ? {}
            : { "cf-access-metadata": metadata },
      });
    }
    assert.equal(url, `${accessSecrets.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  };
  return { calls, fetchPublic };
}

function response(result) {
  return Response.json({
    success: true,
    result,
  });
}

function cloudflare({ deniedPath } = {}) {
  const state = { calls: [] };
  const fetchApi = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ method: options.method, path, body });
    assert.equal(
      options.headers.Authorization,
      `Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
    );
    if (path.endsWith(deniedPath ?? "never-match")) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Do not log test-build-token" }],
        },
        { status: 403 },
      );
    }
    if (path.endsWith("/workers/subdomain"))
      return response({ subdomain: "test-subdomain" });
    assert.fail(`Unexpected API call: ${options.method} ${path}`);
  };
  return { state, fetchApi };
}

function deploymentRunner({ initialSecrets = {}, failDeployment = 0 } = {}) {
  const runtimeSecrets = { ...initialSecrets };
  const uploads = [];
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "queues")
      return { exitCode: 0, stdout: "Queue exists", stderr: "" };
    if (args[0] === "secret")
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          Object.keys(runtimeSecrets).map((name) => ({ name })),
        ),
        stderr: "",
      };
    assert.equal(args[0], "deploy");
    const file = args[args.indexOf("--secrets-file") + 1];
    let secrets = {};
    if (args.includes("--secrets-file")) {
      const content = await readFile(file, "utf8");
      secrets = file.endsWith(".json")
        ? JSON.parse(content)
        : parseEnv(content);
      if (file.includes("taiwan-fin-hub-deploy-"))
        assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    uploads.push({
      args,
      secrets,
      file: args.includes("--secrets-file") ? file : null,
    });
    if (uploads.length === failDeployment) return { exitCode: 2 };
    Object.assign(runtimeSecrets, secrets);
    return { exitCode: 0 };
  };
  return { run, runtimeSecrets, uploads, calls };
}

function options(api, runner, extra = {}) {
  return {
    run: runner.run,
    environment,
    readConfig: async () => config,
    fetchApi: api.fetchApi,
    fetchPublic: publicAccess().fetchPublic,
    ...extra,
  };
}

test("automatic setup is limited to Workers Builds with missing credentials", () => {
  const input = { environment, existingSecrets: new Set() };
  assert.equal(needsAccessSetup(input), true);
  assert.equal(needsAccessSetup({ ...input, environment: {} }), false);
  assert.equal(
    needsAccessSetup({
      ...input,
      environment: { ...environment, ACCESS_AUTO_SETUP: "false" },
    }),
    false,
  );
  assert.equal(
    needsAccessSetup({ ...input, suppliedSecrets: { DEMO_MODE: "true" } }),
    false,
  );
  assert.equal(
    needsAccessSetup({ ...input, config: { vars: { DEMO_MODE: "on" } } }),
    false,
  );
  assert.equal(
    needsAccessSetup({
      ...input,
      existingSecrets: new Set(Object.keys(accessSecrets)),
    }),
    false,
  );
  assert.equal(
    needsAccessSetup({ ...input, existingSecrets: new Set(["TEAM_DOMAIN"]) }),
    true,
  );
  assert.equal(
    needsAccessSetup({
      ...input,
      environment: { ...environment, ACCESS_AUTO_SETUP: "true" },
      existingSecrets: new Set(Object.keys(accessSecrets)),
    }),
    true,
  );
});

test("GUI Access deploys verified secrets using the default build token without Access API permissions", async () => {
  const api = cloudflare();
  const guiWorkerName = "my-finances";
  const guiWorkerUrl = `https://${guiWorkerName}.test-subdomain.workers.dev/`;
  const publicApi = publicAccess({
    url: guiWorkerUrl,
    metadata: signedMetadata({ hostname: new URL(guiWorkerUrl).hostname }),
  });
  const runner = deploymentRunner();
  const directory = await mkdtemp(join(tmpdir(), "access-test-"));
  const source = join(directory, "supplied.env");
  await writeFile(source, "CONFIG_ENCRYPTION_KEY=user-encryption-key\n");
  const nativeOptions = {
    environment: {
      ...environment,
      WRANGLER_CI_OVERRIDE_NAME: guiWorkerName,
    },
    fetchPublic: publicApi.fetchPublic,
  };
  try {
    assert.equal(
      await deploy(
        ["--secrets-file", source],
        options(api, runner, nativeOptions),
      ),
      0,
    );
    assert.equal(runner.uploads.length, 2);
    assert.deepEqual(runner.uploads[1].secrets, accessSecrets);
    assert.deepEqual(runner.runtimeSecrets, {
      ...runner.uploads[0].secrets,
      ...accessSecrets,
    });
    assert.equal(
      runner.runtimeSecrets.CONFIG_ENCRYPTION_KEY,
      "user-encryption-key",
    );
    assert.equal(
      Buffer.from(runner.runtimeSecrets.VAPID_PUBLIC_KEY, "base64url").length,
      65,
    );
    assert.equal(
      Buffer.from(runner.runtimeSecrets.VAPID_PRIVATE_KEY, "base64url").length,
      32,
    );
    assert.deepEqual(api.state.calls, [
      {
        method: "GET",
        path: `/client/v4/accounts/${accountId}/workers/subdomain`,
        body: undefined,
      },
    ]);
    assert.deepEqual(publicApi.calls, [
      guiWorkerUrl,
      `${accessSecrets.TEAM_DOMAIN}/cdn-cgi/access/certs`,
    ]);
    for (const upload of runner.uploads)
      await assert.rejects(access(upload.file), { code: "ENOENT" });

    const original = { ...runner.runtimeSecrets };
    await deploy([], options(api, runner, nativeOptions));
    assert.equal(runner.uploads.length, 3);
    assert.equal(api.state.calls.length, 1);
    assert.equal(publicApi.calls.length, 2);
    assert.deepEqual(runner.runtimeSecrets, original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unverified Access metadata is never deployed as runtime credentials", async (t) => {
  const valid = signedMetadata();
  const [header, payload] = valid.split(".");
  const cases = [
    [
      "invalid signature",
      `${header}.${payload}.${Buffer.alloc(256).toString("base64url")}`,
    ],
    [
      "different hostname",
      signedMetadata({ hostname: "other-worker.test-subdomain.workers.dev" }),
    ],
    [
      "expired metadata",
      signedMetadata({ iat: Math.floor(Date.now() / 1000) - 86401 }),
    ],
    ["no matching application", signedMetadata({ type: "no_match" })],
    [
      "untrusted auth domain",
      signedMetadata({ auth_domain: "attacker.example" }),
    ],
  ];
  for (const [name, metadata] of cases) {
    await t.test(name, async () => {
      const api = cloudflare();
      const publicApi = publicAccess({ metadata });
      const runner = deploymentRunner({ initialSecrets: vapidSecrets });
      await assert.rejects(
        deploy(
          [],
          options(api, runner, {
            fetchPublic: publicApi.fetchPublic,
          }),
        ),
        /metadata could not be verified/,
      );
      assert.equal(runner.uploads.length, 1);
      assert.equal(runner.runtimeSecrets.TEAM_DOMAIN, undefined);
      assert.equal(runner.runtimeSecrets.POLICY_AUD, undefined);
      if (name === "untrusted auth domain")
        assert.deepEqual(publicApi.calls, [workerUrl]);
    });
  }
});

test("Access discovery retries edge propagation and explains missing GUI protection", async () => {
  const propagation = publicAccess({ missingResponses: 1 });
  assert.deepEqual(
    await discoverAccessSecrets(workerUrl, propagation.fetchPublic),
    accessSecrets,
  );
  assert.deepEqual(propagation.calls.slice(0, 2), [workerUrl, workerUrl]);
  const unprotected = publicAccess({ metadata: null });
  await assert.rejects(
    discoverAccessSecrets(workerUrl, unprotected.fetchPublic),
    /Enable Protect with Cloudflare Access, choose All traffic/,
  );
  assert.equal(unprotected.calls.length, 5);
});

test("deploys verified GUI Access secrets while preserving supplied keys", async () => {
  const api = cloudflare();
  const runner = deploymentRunner();
  const directory = await mkdtemp(join(tmpdir(), "access-test-"));
  const source = join(directory, "supplied.json");
  const supplied = {
    CONFIG_ENCRYPTION_KEY: "user-encryption-key",
    OTHER_SECRET: "user-value",
    ...vapidSecrets,
  };
  await writeFile(source, JSON.stringify(supplied));
  try {
    assert.equal(
      await deploy(["--secrets-file", source], options(api, runner)),
      0,
    );
    assert.deepEqual(runner.runtimeSecrets, { ...supplied, ...accessSecrets });
    assert.deepEqual(runner.uploads[0].secrets, supplied);
    assert.deepEqual(runner.uploads[1].secrets, accessSecrets);
    for (const upload of runner.uploads)
      await assert.rejects(access(upload.file), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates VAPID only once and preserves dotenv secrets in the Access deployment", async () => {
  const api = cloudflare();
  const runner = deploymentRunner();
  const directory = await mkdtemp(join(tmpdir(), "access-test-"));
  const source = join(directory, "supplied.env");
  await writeFile(
    source,
    'CONFIG_ENCRYPTION_KEY="my key with # characters"\nOTHER_SECRET=keep-me\n',
  );
  try {
    await deploy(["--secrets-file", source], options(api, runner));
    assert.equal(
      runner.runtimeSecrets.CONFIG_ENCRYPTION_KEY,
      "my key with # characters",
    );
    assert.equal(runner.runtimeSecrets.OTHER_SECRET, "keep-me");
    assert.equal(
      Buffer.from(runner.runtimeSecrets.VAPID_PUBLIC_KEY, "base64url").length,
      65,
    );
    assert.equal(
      Buffer.from(runner.runtimeSecrets.VAPID_PRIVATE_KEY, "base64url").length,
      32,
    );
    assert.deepEqual(runner.uploads[1].secrets, accessSecrets);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subdomain permission errors do not expose response bodies or write verification secrets", async () => {
  const api = cloudflare({ deniedPath: "/workers/subdomain" });
  const runner = deploymentRunner({ initialSecrets: vapidSecrets });
  await assert.rejects(deploy([], options(api, runner)), (error) => {
    assert.match(error.message, /HTTP 403, codes 10000/);
    assert.doesNotMatch(error.message, /test-build-token/);
    return true;
  });
  assert.equal(runner.uploads.length, 1);
  assert.equal(runner.runtimeSecrets.TEAM_DOMAIN, undefined);
  assert.equal(runner.runtimeSecrets.POLICY_AUD, undefined);
  assert.ok(api.state.calls.every((call) => call.method === "GET"));
});

test("a failed Worker deployment does not query Access metadata or write verification secrets", async () => {
  const api = cloudflare();
  const runner = deploymentRunner({
    initialSecrets: vapidSecrets,
    failDeployment: 1,
  });
  assert.equal(await deploy([], options(api, runner)), 2);
  assert.equal(api.state.calls.length, 0);
  assert.equal(runner.runtimeSecrets.TEAM_DOMAIN, undefined);
  assert.ok(api.state.calls.every((call) => call.method === "GET"));
});

test("retrying a failed verification deployment rediscovers GUI Access and preserves VAPID", async () => {
  const api = cloudflare();
  const first = deploymentRunner({ failDeployment: 2 });
  await assert.rejects(
    deploy([], options(api, first)),
    /Retry the Cloudflare GUI deployment/,
  );
  assert.equal(api.state.calls.length, 1);
  const originalKeys = {
    VAPID_PUBLIC_KEY: first.runtimeSecrets.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: first.runtimeSecrets.VAPID_PRIVATE_KEY,
  };
  const retry = deploymentRunner({ initialSecrets: first.runtimeSecrets });
  await deploy([], options(api, retry));
  assert.equal(api.state.calls.length, 2);
  assert.equal(
    retry.runtimeSecrets.VAPID_PUBLIC_KEY,
    originalKeys.VAPID_PUBLIC_KEY,
  );
  assert.equal(
    retry.runtimeSecrets.VAPID_PRIVATE_KEY,
    originalKeys.VAPID_PRIVATE_KEY,
  );
  assert.deepEqual(retry.uploads[1].secrets, accessSecrets);
  for (const upload of first.uploads)
    await assert.rejects(access(upload.file), { code: "ENOENT" });
});

test("completed legacy deployments do not require Access permissions for updates", async () => {
  for (const argumentsToDeploy of [
    [],
    ["--name=ignored-worker", "--env=production"],
  ]) {
    const api = cloudflare({ deniedPath: "/workers/subdomain" });
    const initialSecrets = { ...accessSecrets, ...vapidSecrets };
    const runner = deploymentRunner({ initialSecrets });
    await deploy(
      argumentsToDeploy,
      options(api, runner, {
        environment: {
          ...environment,
          CLOUDFLARE_API_TOKEN: undefined,
          WRANGLER_CI_OVERRIDE_NAME: workerName,
        },
        readConfig: async () => ({ ...config, name: "all-set-tw" }),
        run: async (args) => {
          if (args[0] === "secret") {
            assert.deepEqual(args, [
              "secret",
              "list",
              "--format",
              "json",
              "--name",
              workerName,
            ]);
          }
          return runner.run(args);
        },
      }),
    );
    assert.equal(api.state.calls.length, 0);
    assert.equal(runner.uploads.length, 1);
    assert.equal(runner.uploads[0].file, null);
    assert.deepEqual(runner.runtimeSecrets, initialSecrets);
  }
});

test("explicit manual credentials are preserved and incomplete credentials are reported", async () => {
  assert.equal(
    needsAccessSetup({
      environment,
      existingSecrets: new Set(),
      suppliedSecrets: accessSecrets,
    }),
    false,
  );
  assert.equal(
    needsAccessSetup({
      environment: { ...environment, ACCESS_AUTO_SETUP: "true" },
      suppliedSecrets: accessSecrets,
    }),
    false,
  );
  assert.equal(
    needsAccessSetup({
      environment: { ...environment, ACCESS_AUTO_SETUP: "true" },
      config: { vars: accessSecrets },
    }),
    false,
  );
  assert.equal(
    needsAccessSetup({
      environment,
      existingSecrets: new Set(["TEAM_DOMAIN", "POLICY_AUDS"]),
    }),
    false,
  );
  assert.throws(
    () =>
      needsAccessSetup({
        environment,
        suppliedSecrets: { POLICY_AUD: "manual-aud" },
      }),
    /Manual Access credentials are incomplete/,
  );
  assert.throws(
    () =>
      needsAccessSetup({
        environment,
        existingSecrets: new Set(Object.keys(accessSecrets)),
        suppliedSecrets: { POLICY_AUD: null },
      }),
    /Manual Access credentials are incomplete/,
  );
});

test("reads the same Wrangler config, named environment, and name override as the deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "access-config-test-"));
  const source = join(directory, "worker.toml");
  await writeFile(
    source,
    'name = "default-worker"\naccount_id = "config-account"\n[env.demo]\nname = "demo-worker"\n[env.demo.vars]\nDEMO_MODE = true\n',
  );
  try {
    const selected = await readDeploymentConfig([
      "--cwd",
      directory,
      "-c",
      "worker.toml",
      "--env=demo",
      "--name",
      "chosen-worker",
    ]);
    assert.equal(selected.name, "chosen-worker");
    assert.equal(selected.account_id, "config-account");
    assert.equal(selected.vars.DEMO_MODE, true);
    assert.equal(selected.configPath, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local deployments, opted-out builds, and Demo builds do not query Access metadata", async () => {
  for (const buildEnvironment of [
    {},
    { ...environment, ACCESS_AUTO_SETUP: "false" },
    { ...environment, DEMO_MODE: "true" },
  ]) {
    const api = cloudflare();
    const runner = deploymentRunner({ initialSecrets: vapidSecrets });
    await deploy([], options(api, runner, { environment: buildEnvironment }));
    assert.equal(api.state.calls.length, 0);
    assert.equal(runner.uploads.length, 1);
  }
});

test("dry-run performs no Access queries, Queue provisioning, or secret writes", async () => {
  const calls = [];
  assert.equal(
    await deploy(["--dry-run"], {
      environment,
      run: async (args) => {
        calls.push(args);
        return { exitCode: 0 };
      },
      readConfig: async () => assert.fail("Dry-run must not read credentials"),
      fetchApi: async () => assert.fail("Dry-run must not call Cloudflare"),
    }),
    0,
  );
  assert.deepEqual(calls, [["deploy", "--dry-run"]]);
});
