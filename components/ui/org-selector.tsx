"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { switchOrganization } from "@/lib/actions/auth";
import type { OrgWithRole } from "@/lib/auth/session";

interface Props {
  orgs: OrgWithRole[];
  activeOrgId: string;
}

export function OrgSelector({ orgs, activeOrgId }: Props) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const orgId = e.target.value;
    if (orgId === activeOrgId) return;
    setIsPending(true);
    await switchOrganization(orgId);
    router.refresh();
    setIsPending(false);
  }

  return (
    <select
      value={activeOrgId}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-700 dark:text-gray-300 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 max-w-[180px] truncate"
      aria-label="Seleccionar organización"
    >
      {orgs.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}
