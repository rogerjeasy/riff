import './production.css';
/** Public diagnostic only: no socket, overlay key, model, private data or effect execution. */
export function ProductionTest() {
  return (
    <main className="production-test">
      <div className="production-test-grid" aria-hidden="true" />
      <section>
        <p>OBS SETUP TEST · NOT LIVE GAMEPLAY</p>
        <h1>Riff source connected</h1>
        <p>Check the selected scene, source bounds and readable text.</p>
        <p>Return to Riff and confirm this frame is visible to enable the live overlay.</p>
        <span>1920 × 1080 reference · source scales to your selected dimensions</span>
      </section>
    </main>
  );
}
