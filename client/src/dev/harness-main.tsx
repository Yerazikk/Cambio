import { createRoot } from "react-dom/client";
import { Harness } from "./Harness.js";
import "./harness.css";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from dev.html");

/*
  Deliberately not in StrictMode. The panes are iframes, and remounting them
  twice on purpose would have every seat create or join the table twice over.
  Each pane runs its own StrictMode inside, where it means something.
*/
createRoot(host).render(<Harness />);
