"use client";
import { useState } from "react";
import { signOut } from "@/lib/actions/auth";

interface Props {
  email: string;
  displayName: string | null;
}

export function UserMenu({ email, displayName }: Props) {
  const [open, setOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const initials = (displayName ?? email)[0]?.toUpperCase() ?? "U";

  async function handleSignOut() {
    setIsLoggingOut(true);
    await signOut();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <span className="h-7 w-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-medium flex-shrink-0">
          {initials}
        </span>
        <span className="hidden sm:block max-w-[140px] truncate text-sm">
          {displayName ?? email}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="hidden sm:block flex-shrink-0"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1">
            <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">
                {displayName ?? "Usuario"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                {email}
              </p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isLoggingOut}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              {isLoggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
