// Admit asynchronous request settlements in issuance order. An older request
// may commit while a newer one is still pending, but once the newer request has
// settled, no older success or failure may roll state backward over it.
export class MonotonicRequestGate {
  private issued = 0
  private settled = 0

  begin(): number {
    return ++this.issued
  }

  settle(request: number): boolean {
    if (request <= this.settled) return false
    this.settled = request
    return true
  }

  // Used when a loader's scope is torn down: all work already issued in that
  // scope becomes older than this synthetic settlement.
  invalidate(): void {
    this.settled = ++this.issued
  }
}
