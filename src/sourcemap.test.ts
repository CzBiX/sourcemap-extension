import { describe, expect, it } from "vitest";
import { decodeDataUrlText, extractSourceMappingUrl, recoverSourcesFromMap } from "./sourcemap.ts";

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

const unreachableFetch = async (url: string): Promise<string> => {
  throw new Error(`unexpected fetch: ${url}`);
};

describe("extractSourceMappingUrl", () => {
  it("finds a //# sourceMappingURL comment in JavaScript", () => {
    const text = "console.log(1);\n//# sourceMappingURL=app.js.map\n";
    expect(extractSourceMappingUrl(text, "js")).toBe("app.js.map");
  });

  it("accepts the legacy //@ sourceMappingURL comment", () => {
    const text = "console.log(1);\n//@ sourceMappingURL=app.js.map\n";
    expect(extractSourceMappingUrl(text, "js")).toBe("app.js.map");
  });

  it("finds a /*# sourceMappingURL */ comment in CSS", () => {
    const text = "body{color:red}\n/*# sourceMappingURL=style.css.map */\n";
    expect(extractSourceMappingUrl(text, "css")).toBe("style.css.map");
  });
});

describe("decodeDataUrlText", () => {
  it("decodes a base64 JSON data URL", () => {
    const json = JSON.stringify({ version: 3, sources: ["a.js"] });
    const url = `data:application/json;base64,${encodeBase64(json)}`;
    expect(decodeDataUrlText(url)).toBe(json);
  });

  it("throws Invalid data URL for a malformed value", () => {
    expect(() => decodeDataUrlText("data:no-comma-here")).toThrow(/^Invalid data URL:/);
  });
});

describe("recoverSourcesFromMap", () => {
  it("recovers a sourcesContent file from an inline base64 data map", async () => {
    const inlineMap = JSON.stringify({
      version: 3,
      sources: ["src/inline.js"],
      sourcesContent: ["export const inline = true;"]
    });
    const mapText = decodeDataUrlText(`data:application/json;base64,${encodeBase64(inlineMap)}`);

    const { map, files } = await recoverSourcesFromMap(
      mapText,
      "data:application/json;base64,ignored",
      "https://example.com/inline.min.js",
      unreachableFetch
    );

    expect(map.recoveredCount).toBe(1);
    expect(map.missingCount).toBe(0);
    expect(files).toEqual([
      {
        path: "sources/src/inline.js",
        content: "export const inline = true;",
        source: "src/inline.js",
        sourceUrl: null,
        mapUrl: "data:application/json;base64,ignored",
        generatedUrls: ["https://example.com/inline.min.js"]
      }
    ]);
  });

  it("applies sourceRoot and yields sources/src/app.js", async () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "src",
      sources: ["app.js"],
      sourcesContent: ["export const x = 1;"]
    });

    const { files } = await recoverSourcesFromMap(mapText, "https://example.com/app.min.js.map", null, unreachableFetch);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("sources/src/app.js");
    expect(files[0]?.content).toBe("export const x = 1;");
  });

  it("recovers files from both sections of an index map", async () => {
    const mapText = JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { version: 3, sources: ["a.js"], sourcesContent: ["const a = 1;"] }
        },
        {
          offset: { line: 10, column: 0 },
          map: { version: 3, sources: ["b.js"], sourcesContent: ["const b = 2;"] }
        }
      ]
    });

    const { map, files } = await recoverSourcesFromMap(mapText, "https://example.com/bundle.js.map", null, unreachableFetch);

    expect(map.recoveredCount).toBe(2);
    expect(files.map((file) => file.path).sort()).toEqual(["sources/a.js", "sources/b.js"]);
  });

  it("reports a missing source when sourcesContent is absent and the URL is not fetchable", async () => {
    const mapText = JSON.stringify({
      version: 3,
      sources: ["webpack://app/missing.ts"],
      sourcesContent: [null]
    });

    const { map, files } = await recoverSourcesFromMap(mapText, "https://example.com/app.js.map", null, unreachableFetch);

    expect(files).toHaveLength(0);
    expect(map.missing).toHaveLength(1);
    expect(map.missing[0]?.reason).toContain("not fetchable");
  });

  it("suffixes colliding paths with different content as __2, __3, ...", async () => {
    const mapText = JSON.stringify({
      version: 3,
      sources: ["app.js", "../app.js"],
      sourcesContent: ["const first = 1;", "const second = 2;"]
    });

    const { files } = await recoverSourcesFromMap(mapText, "https://example.com/app.js.map", null, unreachableFetch);

    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual(["sources/app.js", "sources/app__2.js"]);
  });
});
