export function summarizeFiles(files: ReadonlyArray<Pick<File, "name" | "size">>, root?: Pick<File, "size">) {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    rootBytes: root?.size,
    largestBytes: files.reduce((max, file) => Math.max(max, file.size), 0),
  };
}

export type StageLoadMetrics = ReturnType<typeof summarizeFiles> & {
  state: "loading" | "complete" | "failed";
  importMs?: number;
  openMs?: number;
  extractionMs?: number;
  runtimeMs?: number;
};
