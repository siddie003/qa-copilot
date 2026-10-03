import { AppShell } from "@/components/layout/app-shell";
import { requirePageUser } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return <AppShell user={{ name: user.name, email: user.email }}>{children}</AppShell>;
}
