// In-memory store. Stands in for a database so the sample stays dependency-free.
export function createStore() {
  return {
    payments: new Map(),
    refunds: new Map(),
    ledger: [],
  };
}
