import { defineApp } from "kitshn";

// Fork: the Android APK mirror on apk.yarden-zamir.com (scripts/apk-mirror/worker.js).
export default defineApp({
  worker: {
    main: "scripts/apk-mirror/worker.js",
    compatibilityDate: "2026-10-01",
    vars: { REPO: "Yarden-zamir/t3code" },
  },
  deploy: [
    {
      on: "push",
      branch: "main",
      name: "prod",
      address: ["apk.yarden-zamir.com"],
      startsIn: "Everyone",
    },
  ],
});
