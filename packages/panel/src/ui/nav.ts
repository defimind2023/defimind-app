/**
 * On a phone the tabs scroll under the pinned Stop. A tab only partly in view would show a fragment
 * like "Ex", so it stays transparent until it is whole. Opacity, not visibility: a hidden tab must
 * still take focus, and focusing it scrolls it into view.
 */
export function wholeTabs(nav: HTMLElement) {
  const stop = nav.querySelector<HTMLElement>('a.stop')
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle('cut', entry.intersectionRatio < 0.99)
      }
    },
    { root: nav, rootMargin: `0px -${stop?.offsetWidth ?? 0}px 0px 0px`, threshold: [0, 0.99, 1] },
  )
  for (const tab of nav.querySelectorAll('a:not(.stop)')) {
    observer.observe(tab)
  }
}
