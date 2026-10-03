import "server-only";
import { AppError } from "@qa/core";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getProject } from "./projects";
import { requirePageUser } from "./session";

/**
 * Loads a project for the signed-in user within one request (deduplicated between layout and
 * page). Missing or foreign projects render the 404 page.
 */
export const loadProjectForPage = cache(async (id: string) => {
  const user = await requirePageUser();
  try {
    return { user, project: await getProject(user.id, id) };
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
});
