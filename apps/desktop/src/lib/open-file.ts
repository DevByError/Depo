import { create } from "zustand";
import { useUi } from "@/store/ui";

interface OpenFileState {
  /** A project file (relative path, forward slashes) the Files tab should show next. */
  path: string | null;
  request(path: string): void;
  clear(): void;
}

export const useOpenFile = create<OpenFileState>((set) => ({
  path: null,
  request: (path) => set({ path }),
  clear: () => set({ path: null }),
}));

/** Show a project file in the Files tab (from the code map, hot spots and so on). */
export function openInFiles(path: string): void {
  useOpenFile.getState().request(path.replace(/\\/g, "/"));
  useUi.getState().setCenterTab("files");
}
