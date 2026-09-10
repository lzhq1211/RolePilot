/**
 * Persistence module (placeholder — full implementation in V1.0).
 * Handles localStorage draft save/load and embedded state.
 */

/**
 * Initialize persistence layer.
 */
function initPersistence() {
  // Will be implemented in V1.0
}

/**
 * Load state on startup: embedded state first, then check localStorage.
 * @returns {object|null}
 */
function loadInitialState() {
  // Try embedded state (from saved HTML)
  const embedded = loadEmbeddedState();
  if (embedded) {
    return embedded;
  }

  // Otherwise return default state
  return createDefaultState();
}
