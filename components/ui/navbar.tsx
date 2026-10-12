import { UserMenu } from "./user-menu";
import { NotificationsBell } from "./notifications-bell";
import { OrgSelector } from "./org-selector";
import type { SessionData } from "@/lib/auth/session";

interface Props {
  session: SessionData;
}

export function Navbar({ session }: Props) {
  return (
    <header className="h-14 flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center px-4 gap-3">
      {/* Org name / logo placeholder */}
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-sm text-gray-900 dark:text-white truncate block">
          {session.activeOrg.name}
        </span>
      </div>

      {/* Org selector — only visible when user belongs to multiple orgs */}
      {session.orgs.length > 1 && (
        <OrgSelector orgs={session.orgs} activeOrgId={session.activeOrg.id} />
      )}

      {/* Junto al nombre de usuario y no dentro de Mi Día: un aviso que
          solo se ve al entrar a una pantalla concreta no es una campanita. */}
      <NotificationsBell />

      <UserMenu email={session.email} displayName={session.displayName} />
    </header>
  );
}
