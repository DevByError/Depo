import { requestFile } from "@/store/nav";
import { useUi } from "@/store/ui";

/** Show a project file in the Files tab (from the code map, hot spots and so on). */
export function openInFiles(path: string, line: number | null = null): void {
  requestFile(path, line);
  useUi.getState().setCenterTab("files");
}
