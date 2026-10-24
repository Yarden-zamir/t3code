import { requireOptionalNativeModule, type NativeModule } from "expo";
import { Platform } from "react-native";

/** Fork: the screen context of the latest press of the Android assistant button. */
export interface AssistantCapture {
  /** Changes on each press; the panel resets its draft when it changes. */
  readonly id: number;
  readonly sourcePackage: string | null;
  readonly webUri: string | null;
  readonly screenText: string | null;
  /** Text that was selected in the app on screen. */
  readonly selectedText: string | null;
  readonly screenshotUri: string | null;
  /** Pixels; 0 until the screenshot arrives. */
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  /** Text and an image that another app shared to "Ask T3 Code". */
  readonly sharedText: string | null;
  readonly sharedImageUri: string | null;
}

export interface RecentPhoto {
  /** A content URI; copy it with `copyToCache` before attaching. */
  readonly uri: string;
  readonly addedAtMs: number;
}

export interface LastLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly timeMs: number;
}

/** Points are flat x, y pairs as fractions of the image; the width is a fraction of its width. */
export interface AnnotationStroke {
  readonly points: ReadonlyArray<number>;
  readonly width: number;
  readonly color: string;
}

type AssistantEvents = {
  readonly onCapture: (capture: AssistantCapture) => void;
  /** The gallery changed while `watchPhotos(true)` is on. */
  readonly onPhotosChanged: () => void;
};

declare class T3AssistantModule extends NativeModule<AssistantEvents> {
  getCapture(): AssistantCapture | null;
  close(): void;
  openAssistantSettings(): void;
  recognizeSpeech(): Promise<string | null>;
  annotateImage(uri: string, strokes: ReadonlyArray<AnnotationStroke>): Promise<string>;
  recentPhoto(maxAgeSeconds: number): Promise<RecentPhoto | null>;
  copyToCache(uri: string): Promise<string>;
  lastLocation(): Promise<LastLocation | null>;
  placeName(latitude: number, longitude: number): Promise<string | null>;
  watchPhotos(watching: boolean): void;
}

export const assistantNative =
  Platform.OS === "android" ? requireOptionalNativeModule<T3AssistantModule>("T3Assistant") : null;
