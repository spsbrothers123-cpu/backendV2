/**
 * Push-ready seam (D-25). FCM / Capacitor push is DEFERRED to B3.8 behind a
 * feature flag; nothing here sends a push. Once a notification commits, every
 * registered hook receives a minimal, content-free event so a future push
 * channel can subscribe without touching the notification core.
 */
import { env } from "../config/env.js";

export interface DeliveryEvent {
  notificationId: string;
  audience: "ADMIN" | "CASHIER";
  type: string;
  recipientUserIds: string[];
}

export type DeliveryHook = (event: DeliveryEvent) => void | Promise<void>;

const hooks: DeliveryHook[] = [];

/** B3.8 will register its FCM dispatcher here, only when this returns true. */
export const isPushEnabled = (): boolean => env.NOTIFICATION_PUSH_ENABLED === true;

export function registerDeliveryHook(hook: DeliveryHook): () => void {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

/** Fire-and-forget after commit: a failing hook can never fail or roll back a notification. */
export async function dispatchDelivery(event: DeliveryEvent): Promise<void> {
  for (const hook of [...hooks]) {
    try {
      await hook(event);
    } catch (err) {
      console.error("notification delivery hook failed", { type: event.type, err: (err as Error).message });
    }
  }
}
