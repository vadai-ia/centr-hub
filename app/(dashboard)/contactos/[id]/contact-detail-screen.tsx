"use client";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContactDetailBundle } from "@/lib/actions/contacts";
import { OpportunityDialog } from "@/components/opportunity/opportunity-dialog";
import {
  CreateInShopifyDialog,
  type CreateInShopifyPrefill,
} from "@/components/contacts/create-in-shopify-dialog";
import { ReassignAdvisorDialog } from "@/components/contacts/reassign-advisor-dialog";
import { parseStoredAddress } from "@/lib/contacts/address";
import { ContactHeader } from "./contact-header";
import { ContactIndicators } from "./contact-indicators";
import { ContactOpportunities } from "./contact-opportunities";
import { ContactTimeline } from "./contact-timeline";
import { ContactForm } from "./contact-form";
import { ContactFormReadonly } from "./contact-form-readonly";

interface Props {
  bundle: ContactDetailBundle;
}

/**
 * Wrapper Client del detalle de contacto (M6 — B3).
 *
 * Coordina sub-componentes y maneja:
 *   - Toast simple para feedback de stubs (B6/B7/B8 reemplazarán
 *     handlers por modales reales).
 *   - Estado local del popup de oportunidad cuando B4 se conecte:
 *     hoy las cards usan Link a `?opp=<id>` — B4 leerá ese param
 *     y montará el popup global.
 *
 * Sub-componentes ya hablan español y se mantienen <200 líneas cada
 * uno para no exceder el límite operativo del proyecto (<300 líneas).
 */
export function ContactDetailScreen({ bundle }: Props) {
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null);
  const [shopifyDialogOpen, setShopifyDialogOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);

  const showStub = useCallback((label: string) => {
    setToast(`${label}: disponible al cerrar M6.`);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const shopifyPrefill: CreateInShopifyPrefill = {
    contactId: bundle.detail.contact.id,
    fullName: bundle.detail.contact.full_name,
    email: bundle.detail.contact.email,
    phone: bundle.detail.contact.phone,
    address: parseStoredAddress(bundle.detail.contact.address),
  };

  return (
    <div className="flex flex-col gap-4">
      <ContactHeader
        detail={bundle.detail}
        advisors={bundle.advisors}
        canEdit={bundle.canEdit}
        canReassign={bundle.canReassign}
        onEdit={() => {
          const el = document.getElementById("contact-info-section");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onReassign={() => setReassignOpen(true)}
        onCreateInShopify={() => setShopifyDialogOpen(true)}
      />

      <ContactIndicators indicators={bundle.detail.indicators} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ContactOpportunities
          venta={bundle.detail.opportunities.venta}
          postVenta={bundle.detail.opportunities.postVenta}
          advisors={bundle.advisors}
        />
        <ContactTimeline events={bundle.timeline} />
      </div>

      <div id="contact-info-section">
        {bundle.canEdit ? (
          <ContactForm
            contact={bundle.detail.contact}
            onSaved={(msg) => showToast(msg)}
          />
        ) : (
          <ContactFormReadonly contact={bundle.detail.contact} />
        )}
      </div>

      {toast && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 max-w-sm px-4 py-3 rounded-md shadow-lg bg-gray-900 text-gray-100 dark:bg-gray-100 dark:text-gray-900 text-sm"
        >
          {toast}
        </div>
      )}

      <OpportunityDialog />

      <CreateInShopifyDialog
        open={shopifyDialogOpen}
        prefill={shopifyDialogOpen ? shopifyPrefill : null}
        onCancel={() => setShopifyDialogOpen(false)}
        onSuccess={(result) => {
          setShopifyDialogOpen(false);
          showToast(
            result.alreadyExisted
              ? "Customer ya existía en Shopify; se vinculó al contacto."
              : "Customer creado en Shopify y enlazado al contacto.",
          );
          // Refresca el Server Component para reflejar la transición
          // lead → cliente y el shopify_customer_id recién enlazado.
          router.refresh();
        }}
      />

      <ReassignAdvisorDialog
        open={reassignOpen}
        entityType="contact"
        entityId={bundle.detail.contact.id}
        currentMembershipId={bundle.detail.contact.assigned_advisor_id}
        advisors={bundle.advisors}
        onCancel={() => setReassignOpen(false)}
        onSuccess={() => {
          setReassignOpen(false);
          showToast("Asesor reasignado.");
          router.refresh();
        }}
      />
    </div>
  );
}
