export type FigmaUrlResult =
  | {
      ok: true;
      url: string;
      /** Key used with the API: the file key, or the branch key for a branch link. */
      fileKey: string;
      /** Main file key when the link points to a branch. */
      mainFileKey?: string;
      nodeIds: string[];
    }
  | { ok: false; message: string };

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);
const FILE_TYPES = new Set(["file", "design", "proto", "board"]);
const KEY = /^[A-Za-z0-9]{10,128}$/;

/**
 * Parses a Figma file/design link into its file key and optional node id.
 * Accepts figma.com/{file|design|proto|board}/<key>/<name>?node-id=1-2 (node ids use "-" in URLs,
 * ":" in the API) and branch links figma.com/design/<key>/branch/<branchKey>/<name> (the API
 * accepts the branch key in place of the file key). Only extracts identifiers from the link; it
 * does not contact Figma.
 */
export function parseFigmaUrl(raw: string): FigmaUrlResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {
      ok: false,
      message: "Enter a valid Figma link, e.g. https://www.figma.com/design/<file-key>/<name>",
    };
  }
  if (url.protocol !== "https:" || !FIGMA_HOSTS.has(url.hostname.toLowerCase()))
    return { ok: false, message: "The link must be an https://www.figma.com URL" };

  const [type, key, maybeBranch, branchKey] = url.pathname.split("/").filter(Boolean);
  if (!type || !FILE_TYPES.has(type) || !key || !KEY.test(key))
    return { ok: false, message: "This Figma link does not point to a design file" };
  const branch = maybeBranch === "branch" ? branchKey : undefined;
  if (maybeBranch === "branch" && (!branch || !KEY.test(branch)))
    return { ok: false, message: "The branch in this Figma link is not valid" };

  const nodeIds: string[] = [];
  const nodeParam = url.searchParams.get("node-id");
  if (nodeParam) {
    const nodeId = nodeParam.replace(/-/g, ":");
    if (!/^\d+:\d+$/.test(nodeId))
      return { ok: false, message: "The node-id in this Figma link is not valid" };
    nodeIds.push(nodeId);
  }

  const canonical = new URL(
    `https://www.figma.com/${type}/${key}${branch ? `/branch/${branch}` : ""}`,
  );
  if (nodeParam) canonical.searchParams.set("node-id", nodeParam);
  return {
    ok: true,
    url: canonical.toString(),
    fileKey: branch ?? key,
    ...(branch ? { mainFileKey: key } : {}),
    nodeIds,
  };
}
