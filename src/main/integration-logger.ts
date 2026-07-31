import { JsonStore } from "./store";
import { IntegrationLogCategory } from "../shared/types";

export type IntegrationLogger = (category: IntegrationLogCategory, title: string, payload?: unknown) => void;

export function createIntegrationLogger(store: JsonStore, onChange: () => void): IntegrationLogger {
  return (category, title, payload) => {
    store.addIntegrationLog(category, title, payload);
    onChange();
  };
}
