import "./App.css";
import { AppHeader } from "./ui/AppHeader.js";

/**
 * The single page of spec section 2. The shell is deliberately thin: a header
 * with the balance and one menu, a main region that holds whichever of the
 * three states the upload is in, and a footer that states the retention rule
 * the product sells (spec section 8).
 */
export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <AppHeader balance={null} onOpenWallet={() => undefined} menuItems={[]} />

      <main className="container main">
        <section className="hero stack">
          <h1>Translate a subtitle file, or a whole season.</h1>
          <p className="hero-lead">
            Every cue index, timecode, positioning tag and formatting tag comes back exactly as it
            went in. Only the spoken text changes.
          </p>
        </section>
      </main>

      <footer className="container app-footer">
        <p className="faint">
          Uploaded and translated files are deleted 24 hours after a job finishes. History is kept
          for 30 days.
        </p>
      </footer>
    </div>
  );
}
