import type { Node } from "./treap.js";

/**
 * Freeze every node object. Shared subtrees are frozen once (Object.freeze on
 * an already-frozen object is a cheap no-op). Freezing is defensive: it makes
 * accidental mutation of old versions fail loudly instead of corrupting them.
 */
export function freeze<V>(node: Node<V>): Node<V> {
  return Object.freeze(node);
}
