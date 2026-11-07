import { create } from "zustand";

export type DeviceWidth = "phone" | "tablet" | "desktop";

/**
 * Real screen sizes in CSS pixels (a common phone, a tablet in portrait, a laptop). The viewer
 * renders the page at exactly this size and scales it down to fit, so what you see is what that
 * screen shows, layout breakpoints included.
 */
export const DEVICE_SIZE: Record<DeviceWidth, { width: number; height: number; name: string }> = {
  phone: { width: 390, height: 844, name: "Phone" },
  tablet: { width: 820, height: 1180, name: "Tablet" },
  desktop: { width: 1440, height: 900, name: "Desktop" },
};

/** Widths of the viewer, kept for callers that only need the width. */
export const DEVICE_WIDTH: Record<DeviceWidth, number> = {
  phone: DEVICE_SIZE.phone.width,
  tablet: DEVICE_SIZE.tablet.width,
  desktop: DEVICE_SIZE.desktop.width,
};

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
