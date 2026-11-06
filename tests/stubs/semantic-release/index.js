// Stand-in for semantic-release under act: never tags or publishes.
// STUB_RELEASE_TYPE=major|minor|patch|none (default minor) picks the result.
export default async function semanticRelease() {
  const type = process.env.STUB_RELEASE_TYPE || "minor";
  console.error(`[stub] semantic-release -> ${type}`);
  if (type === "none") return false;
  const version = { major: "2.0.0", minor: "1.1.0", patch: "1.0.1" }[type] ?? "1.1.0";
  return { nextRelease: { type, version, gitTag: `v${version}` } };
}