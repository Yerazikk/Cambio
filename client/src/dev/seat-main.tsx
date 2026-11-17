import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DevSeat } from "./DevSeat.js";
import "../styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from seat.html");

createRoot(host).render(
  <StrictMode>
    <DevSeat />
  </StrictMode>,
);
