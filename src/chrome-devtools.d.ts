declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined;
  }
  namespace downloads {
    function download(options: {
      url: string;
      filename?: string;
      saveAs?: boolean;
      conflictAction?: "uniquify" | "overwrite" | "prompt";
    }): Promise<number>;
  }
  namespace devtools {
    namespace panels {
      function create(title: string, iconPath: string, pagePath: string, callback?: () => void): void;
    }
    namespace inspectedWindow {
      interface Resource {
        url: string;
        getContent(callback: (content: string | null, encoding: string | null) => void): void;
      }
      function getResources(callback: (resources: Resource[]) => void): void;
      function eval(
        expression: string,
        callback: (result: unknown, isException?: { isError?: boolean; code?: string; value?: string }) => void
      ): void;
    }
  }
}
