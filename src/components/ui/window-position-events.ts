export function listenToWindowPositionChanges(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  window.addEventListener("scroll", listener, true);

  return () => {
    window.removeEventListener("resize", listener);
    window.removeEventListener("scroll", listener, true);
  };
}
