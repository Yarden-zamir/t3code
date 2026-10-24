// File names observed read-only in phone-access/apps/mobile/android/app/build.
// Payloads are not copied from that checkout.
const tables = [
  "inputs/source-to-output",
  "jvm/kotlin/class-attributes",
  "jvm/kotlin/class-fq-name-to-source",
  "jvm/kotlin/internal-name-to-source",
  "jvm/kotlin/proto",
  "jvm/kotlin/source-to-classes",
  "jvm/kotlin/subtypes",
  "jvm/kotlin/supertypes",
  "lookups/file-to-id",
  "lookups/id-to-file",
  "lookups/lookups",
];
const suffixes = [
  ".tab",
  ".tab.keystream",
  ".tab.keystream.len",
  ".tab.len",
  ".tab.values.at",
  ".tab_i",
  ".tab_i.len",
];
export const kotlinCacheInventory = [
  ...tables.flatMap((table) =>
    suffixes.map((suffix) => `kotlin/compileDebugKotlin/cacheable/caches-jvm/${table}${suffix}`),
  ),
  "kotlin/compileDebugKotlin/cacheable/caches-jvm/lookups/counters.tab",
  "kotlin/compileDebugKotlin/cacheable/last-build.bin",
  "kotlin/compileDebugKotlin/classpath-snapshot/shrunk-classpath-snapshot.bin",
];
