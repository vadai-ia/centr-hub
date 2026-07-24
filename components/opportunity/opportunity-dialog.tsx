"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  loadOpportunityDetailForDialog,
  type OpportunityDialogBundle,
} from "@/lib/actions/opportunities-m6";
import {
  CreateInShopifyDialog,
  type CreateInShopifyPrefill,
} from "@/components/contacts/create-in-shopify-dialog";
import { ReassignAdvisorDialog } from "@/components/contacts/reassign-advisor-dialog";
import { emptyStructuredAddress } from "@/lib/contacts/address";
import { AddNoteDialog } from "./add-note-dialog";
import { CreateTaskDialog } from "./create-task-dialog";
import { ResolveCaseDialog } from "./resolve-case-dialog";
import { OpportunityDialogContent } from "./opportunity-dialog-content";

interface Props {
  /** Param de URL que controla el dialog. Default `opp`. */
  paramName?: string;
}

/**
 * Popup de detalle de oportunidad (M6 — B4).
 *
 * Modelo: el popup está siempre montado pero solo se muestra cuando
 * el URL contiene `?opp=<uuid>`. Las cards (B3 + B5) son Links que
 * navegan a ese URL — sin handlers de click locales, lo cual evita
 * el problema clásico "click vs drag" del dnd-kit en B5 y mantiene
 * la URL como single source of truth (deeplink + back button del
 * navegador funcionan).
 *
 * Patrón de cierre: ESC, click fuera, botón Cerrar y click en el
 * nombre del contacto (navega a /contactos/[id]) llaman `closeDialog`,
 * que remueve el param `opp` de la URL preservando el resto.
 *
 * Acceso: cada fetch va por `loadOpportunityDetailForDialog` que
 * valida sesión + permisos (admin o asignado). Si retorna forbidden
 * o not_found, el dialog muestra un mensaje y permite cerrar.
 */
export function OpportunityDialog({ paramName = "opp" }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const oppId = searchParams.get(paramName);

  const [bundle, setBundle] = useState<OpportunityDialogBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shopifyDialogOpen, setShopifyDialogOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const closeDialog = useCallback(() => {
    if (!oppId) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete(paramName);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [oppId, pathname, router, searchParams, paramName]);

  // Fetch cuando oppId cambia.
  useEffect(() => {
    if (!oppId) {
      setBundle(null);
      setError(null);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setBundle(null);
    loadOpportunityDetailForDialog({ opportunityId: oppId })
      .then((res) => {
        if (seq !== requestSeq.current) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setBundle(res.bundle);
      })
      .catch((e) => {
        if (seq !== requestSeq.current) return;
        setError(e instanceof Error ? e.message : "Error al cargar la oportunidad");
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [oppId]);

  // ESC + scroll-lock cuando el dialog está abierto.
  useEffect(() => {
    if (!oppId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [oppId, closeDialog]);

  if (!oppId) return null;

  const stubAction = (label: string) => () => {
    // B7/B9 reemplazarán estos stubs por modales reales. Por ahora
    // dejamos rastro en consola para QA visual.
    console.info(`[M6 stub] ${label} pendiente — se conecta en bloques posteriores.`);
  };

  // Pre-fill del modal de Shopify a partir del bundle cargado.
  const shopifyPrefill: CreateInShopifyPrefill | null = bundle
    ? {
        contactId: bundle.detail.contact.id,
        fullName: bundle.detail.contact.full_name,
        email: bundle.detail.contact.email,
        phone: bundle.detail.contact.phone,
        // El popup carga `OpportunityContactSummary`, que solo trae los
        // campos visibles en la card y NO el `address` jsonb completo.
        // Pre-fill vacío: el usuario lo llena/edita en el modal.
        address: emptyStructuredAddress(),
      }
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="opp-dialog-title"
      onClick={closeDialog}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6 outline-none"
      >
        <p id="opp-dialog-title" className="sr-only">
          Detalle de oportunidad
        </p>

        {loading && (
          <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            Cargando oportunidad...
          </div>
        )}

        {error && !loading && (
          <div className="py-8 text-center">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            <button
              type="button"
              onClick={closeDialog}
              className="mt-4 px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cerrar
            </button>
          </div>
        )}

        {bundle && !loading && !error && (
          <OpportunityDialogContent
            bundle={bundle}
            onClose={closeDialog}
            onAddNote={() => setNoteOpen(true)}
            onCreateTask={() => setTaskOpen(true)}
            onReassign={() => setReassignOpen(true)}
            onCreateInShopify={() => setShopifyDialogOpen(true)}
            onResolveCase={() => setResolveOpen(true)}
            onTasksChanged={() => {
              if (oppId) {
                void loadOpportunityDetailForDialog({ opportunityId: oppId }).then((res) => {
                  if (res.ok) setBundle(res.bundle);
                });
              }
              router.refresh();
            }}
          />
        )}
      </div>

      <CreateInShopifyDialog
        open={shopifyDialogOpen}
        prefill={shopifyDialogOpen ? shopifyPrefill : null}
        onCancel={() => setShopifyDialogOpen(false)}
        onSuccess={(result) => {
          setShopifyDialogOpen(false);
          const msg = result.alreadyExisted
            ? "Customer ya existía en Shopify; se vinculó al contacto."
            : "Customer creado en Shopify y enlazado al contacto.";
          setToast(msg);
          setTimeout(() => setToast(null), 3500);
          // Recarga el bundle del popup para reflejar lead → cliente.
          if (oppId) {
            void loadOpportunityDetailForDialog({ opportunityId: oppId }).then((res) => {
              if (res.ok) setBundle(res.bundle);
            });
          }
          // El listado / detalle de contacto detrás del popup también
          // pueden necesitar refresh — el caller que abrió el popup
          // (router.push hace soft nav) lo hará al cerrar.
          router.refresh();
        }}
      />

      <AddNoteDialog
        open={noteOpen}
        opportunityId={bundle?.detail.opportunity.id ?? null}
        onCancel={() => setNoteOpen(false)}
        onSuccess={() => {
          setNoteOpen(false);
          setToast("Nota agregada.");
          setTimeout(() => setToast(null), 3500);
          if (oppId) {
            void loadOpportunityDetailForDialog({ opportunityId: oppId }).then((res) => {
              if (res.ok) setBundle(res.bundle);
            });
          }
          router.refresh();
        }}
      />

      <CreateTaskDialog
        open={taskOpen}
        opportunityId={bundle?.detail.opportunity.id ?? null}
        onCancel={() => setTaskOpen(false)}
        onSuccess={() => {
          setTaskOpen(false);
          setToast("Tarea creada.");
          setTimeout(() => setToast(null), 3500);
          if (oppId) {
            void loadOpportunityDetailForDialog({ opportunityId: oppId }).then((res) => {
              if (res.ok) setBundle(res.bundle);
            });
          }
          router.refresh();
        }}
      />

      <ResolveCaseDialog
        open={resolveOpen}
        opportunityId={bundle?.detail.opportunity.id ?? null}
        onCancel={() => setResolveOpen(false)}
        onSuccess={() => {
          setResolveOpen(false);
          setToast("Caso marcado como resuelto.");
          setTimeout(() => setToast(null), 3500);
          // El caso resuelto sale del pipeline activo → cerrar el popup y
          // refrescar el tablero detrás (la card desaparece de la vista activa).
          closeDialog();
          router.refresh();
        }}
      />


      <ReassignAdvisorDialog
        open={reassignOpen}
        entityType="opportunity"
        entityId={bundle?.detail.opportunity.id ?? null}
        currentMembershipId={bundle?.detail.opportunity.assigned_advisor_id ?? null}
        advisors={bundle?.advisors ?? []}
        onCancel={() => setReassignOpen(false)}
        onSuccess={() => {
          setReassignOpen(false);
          setToast("Asesor de la oportunidad reasignado.");
          setTimeout(() => setToast(null), 3500);
          if (oppId) {
            void loadOpportunityDetailForDialog({ opportunityId: oppId }).then((res) => {
              if (res.ok) setBundle(res.bundle);
            });
          }
          router.refresh();
        }}
      />

      {toast && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[60] max-w-sm px-4 py-3 rounded-md shadow-lg bg-gray-900 text-gray-100 dark:bg-gray-100 dark:text-gray-900 text-sm"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
