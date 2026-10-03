import "server-only";
import { AppError } from "@qa/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

/** Resolves the signed-in user from request headers (session cookie), or null. */
export async function getUserFromHeaders(h: Headers): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) return null;
  const { id, name, email } = session.user;
  return { id, name, email };
}

/** For API route handlers: throws 401 when there is no valid session. */
export async function requireApiUser(h: Headers): Promise<CurrentUser> {
  const user = await getUserFromHeaders(h);
  if (!user) throw new AppError("UNAUTHORIZED", "Sign in to continue");
  return user;
}

/** For server components: redirects to /login when there is no valid session. */
export async function requirePageUser(): Promise<CurrentUser> {
  const user = await getUserFromHeaders(await headers());
  if (!user) redirect("/login");
  return user;
}
