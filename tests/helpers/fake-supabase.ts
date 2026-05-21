/**
 * Fake supabase client en memoria — solo para tests M3 que necesitan
 * verificar interacción con BD (parser de tags, sync loop defense,
 * identity matching). NO mantiene relaciones FK ni RLS — es una
 * tabla por nombre con filas {organization_id?, ...}.
 *
 * Soporta el subset de operaciones usadas por `lib/db/*` y servicios:
 *   - select * con eq, in, is, or
 *   - .single() / .maybeSingle()
 *   - insert / update / upsert / delete con filtros
 *   - encadenamiento típico
 */

type Row = Record<string, unknown>;

interface BuilderState {
  table: string;
  action: "select" | "insert" | "update" | "delete" | "upsert";
  filters: Array<{
    field: string;
    op: "eq" | "in" | "is" | "or" | "not_is";
    value: unknown;
  }>;
  payload?: unknown;
  conflictTarget?: string;
}

export class FakeSupabase {
  public tables: Record<string, Row[]> = {};
  public history: BuilderState[] = [];
  public rpcResults: Record<string, unknown> = {};

  reset(): void {
    this.tables = {};
    this.history = [];
    this.rpcResults = {};
  }

  setTable(name: string, rows: Row[]): void {
    this.tables[name] = rows;
  }

  getTable(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  from(table: string) {
    const supabase = this;
    return {
      select: (_cols?: string) => supabase.buildSelect(table),
      insert: (payload: Row | Row[]) => supabase.buildMutation(table, "insert", payload),
      update: (payload: Row) => supabase.buildMutation(table, "update", payload),
      upsert: (payload: Row, opts?: { onConflict?: string }) =>
        supabase.buildMutation(table, "upsert", payload, opts?.onConflict),
      delete: () => supabase.buildMutation(table, "delete", undefined),
    };
  }

  rpc(name: string, _args?: unknown) {
    return Promise.resolve({ data: this.rpcResults[name] ?? null, error: null });
  }

  private buildSelect(table: string) {
    const state: BuilderState = { table, action: "select", filters: [] };
    this.history.push(state);
    const self = this;
    const builder: Record<string, unknown> = {
      eq(field: string, value: unknown) {
        state.filters.push({ field, op: "eq", value });
        return builder;
      },
      in(field: string, values: unknown[]) {
        state.filters.push({ field, op: "in", value: values });
        return builder;
      },
      is(field: string, value: unknown) {
        state.filters.push({ field, op: "is", value });
        return builder;
      },
      not(field: string, op: string, value: unknown) {
        // Soporte mínimo: not("col", "is", null) → col IS NOT NULL.
        if (op === "is") {
          state.filters.push({ field, op: "not_is", value });
        }
        return builder;
      },
      or(expr: string) {
        state.filters.push({ field: "<or>", op: "or", value: expr });
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      range() {
        return builder;
      },
      gte() {
        return builder;
      },
      lte() {
        return builder;
      },
      maybeSingle: () => {
        const rows = self.applyFilters(table, state.filters);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single: () => {
        const rows = self.applyFilters(table, state.filters);
        if (rows.length !== 1) {
          return Promise.resolve({
            data: null,
            error: new Error(`single() esperaba 1 fila, recibió ${rows.length}`),
          });
        }
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(resolve: (value: { data: Row[]; error: null }) => void) {
        const rows = self.applyFilters(table, state.filters);
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  private buildMutation(
    table: string,
    action: BuilderState["action"],
    payload?: unknown,
    conflictTarget?: string,
  ) {
    const state: BuilderState = { table, action, filters: [], payload, conflictTarget };
    this.history.push(state);
    const self = this;
    const builder: Record<string, unknown> = {
      eq(field: string, value: unknown) {
        state.filters.push({ field, op: "eq", value });
        return builder;
      },
      select(_cols?: string) {
        return builder;
      },
      single: () => {
        const result = self.execute(state);
        if (result.length !== 1) {
          return Promise.resolve({
            data: result[0] ?? null,
            error: result.length === 0 ? new Error("no rows after mutation") : null,
          });
        }
        return Promise.resolve({ data: result[0], error: null });
      },
      maybeSingle: () => {
        const result = self.execute(state);
        return Promise.resolve({ data: result[0] ?? null, error: null });
      },
      then(resolve: (value: { data: Row[]; error: null }) => void) {
        const result = self.execute(state);
        resolve({ data: result, error: null });
      },
    };
    return builder;
  }

  applyFilters(table: string, filters: BuilderState["filters"]): Row[] {
    const rows = this.getTable(table);
    return rows.filter((row) => {
      for (const f of filters) {
        if (f.op === "eq" && row[f.field] !== f.value) return false;
        if (f.op === "in") {
          const arr = f.value as unknown[];
          if (!arr.includes(row[f.field])) return false;
        }
        if (f.op === "is" && row[f.field] !== f.value) return false;
        if (f.op === "not_is" && row[f.field] === f.value) return false;
        // op "or" no se aplica filtrado preciso en este fake
      }
      return true;
    });
  }

  private execute(state: BuilderState): Row[] {
    if (state.action === "insert") {
      const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
      const inserted: Row[] = [];
      for (const row of rows) {
        const r = {
          id: (row as Row).id ?? `row-${Math.random().toString(36).slice(2)}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...row,
        } as Row;
        this.getTable(state.table).push(r);
        inserted.push(r);
      }
      return inserted;
    }
    if (state.action === "update") {
      const matches = this.applyFilters(state.table, state.filters);
      for (const row of matches) {
        Object.assign(row, state.payload, { updated_at: new Date().toISOString() });
      }
      return matches;
    }
    if (state.action === "upsert") {
      const payload = state.payload as Row;
      const target = (state.conflictTarget ?? "id").split(",").map((s) => s.trim());
      const matches = this.getTable(state.table).filter((row) =>
        target.every((f) => row[f] === payload[f]),
      );
      if (matches.length > 0) {
        Object.assign(matches[0], payload, { updated_at: new Date().toISOString() });
        return [matches[0]];
      }
      return this.execute({ ...state, action: "insert" });
    }
    if (state.action === "delete") {
      const matches = this.applyFilters(state.table, state.filters);
      const remaining = this.getTable(state.table).filter((r) => !matches.includes(r));
      this.tables[state.table] = remaining;
      return matches;
    }
    return [];
  }
}

/**
 * Para activar el mock en un test, cada archivo de test debe llamar
 * `vi.mock("@/lib/supabase/admin", ...)` a nivel module-top — vitest
 * hoistea los vi.mock al inicio del archivo. Si lo envolvemos en un
 * helper, vitest lo hoistea fuera de su closure y pierde la referencia.
 *
 * Patrón estándar usado en M3:
 *
 *   const fake = new FakeSupabase();
 *   vi.mock("@/lib/supabase/admin", () => ({
 *     getSupabaseAdminClient: () => fake,
 *   }));
 */
