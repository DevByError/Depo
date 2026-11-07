import { create } from "zustand";

export type DeviceWidth = "phone" | "tablet" | "desktop";

/** Pixel widths of the embedded viewer; desktop fills the space. */
export const DEVICE_WIDTH: Record<DeviceWidth, number | null> = { phone: 375, tablet: 768, desktop: null };

interface PreviewUi {
  /** The project the target belongs to; a target from another project counts as "project folder". */
  projectId: string | null;
  /** What the Preview tab runs: null = the project folder, otherwise a task's private copy. */
  taskId: string | null;
  /** The preview shown (link, viewer, log). */
  previewId: string | null;
  /** Start the target as soon as the Preview tab opens ("Preview these changes"). */
  autoStart: boolean;
  device: DeviceWidth;
  show(o: { projectId: string; taskId: string | null; previewId?: string | null; autoStart?: boolean }): void;
  setPreviewId(id: string | null): void;
  clearAutoStart(): void;
  setDevice(d: DeviceWidth): void;
}

export const usePreviewUi = create<PreviewUi>((set) => ({
  projectId: null,
  taskId: null,
  previewId: null,
  autoStart: false,
  device: "desktop",
  show: (o) =>
    set({
      projectId: o.projectId,
      taskId: o.taskId,
      previewId: o.previewId ?? null,
      autoStart: o.autoStart ?? false,
    }),
  setPreviewId: (previewId) => set({ previewId }),
  clearAutoStart: () => set({ autoStart: false }),
  setDevice: (device) => set({ device }),
}));
