import { connectorConfigSchemas } from "@taiwan-fin-hub/connectors";
import { connectorCatalog } from "@taiwan-fin-hub/core";
import { describe, expect, it } from "vitest";
import { connectorRuntimeRegistry } from "../../../src/features/sync/registry";

describe("connector registry completeness", () => {
  it("keeps catalog, config schemas, and Worker runtimes in lockstep", () => {
    const expected = Object.keys(connectorCatalog).sort();

    expect(Object.keys(connectorConfigSchemas).sort()).toEqual(expected);
    expect(Object.keys(connectorRuntimeRegistry).sort()).toEqual(expected);
    for (const [id, definition] of Object.entries(connectorCatalog)) {
      expect(definition.id).toBe(id);
    }
  });

  it("declares all connectors with an all scope", () => {
    for (const definition of Object.values(connectorCatalog)) {
      expect(definition.scopes).toContain("all");
    }
  });

  it("keeps catalog-managed fields in each connector config schema", () => {
    for (const { id: connectorId } of Object.values(connectorCatalog)) {
      const schema = connectorConfigSchemas[connectorId] as unknown as {
        shape: Record<string, unknown>;
      };
      const schemaFields = Object.keys(schema.shape);
      const definition = connectorCatalog[connectorId];

      expect(schemaFields).toEqual(
        expect.arrayContaining([
          ...definition.credentialFields,
          ...definition.publicFields,
          ...definition.secretStateFields,
        ]),
      );
    }
  });
});
