import { and, eq, isNull } from "drizzle-orm";
import { project } from "../schema";

/**
 * Ownership filter used by every read in the app: the project belongs to the user, is not
 * deleted, and is in the requested workspace (real vs demo). Join `project` before applying.
 */
export const ownedProjects = (ownerId: string, isDemo = false) =>
  and(eq(project.ownerId, ownerId), isNull(project.deletedAt), eq(project.isDemo, isDemo));
