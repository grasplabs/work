// The Sidebar's kept folds on the first paint: a script for the page's <head>, as the theme's is
// (src/theme/script.ts). A group the person folded is drawn folded from the start, and one they
// opened is drawn open, so nothing shifts when the page wakes. Pass the Sidebar's `storageKey`.
//
//   <script is:inline set:html={sidebarFoldScript("docs-sidebar")} />                    Astro
//   <script dangerouslySetInnerHTML={{ __html: sidebarFoldScript("docs-sidebar") }} />   React
//
// It writes a style that holds each kept group's rows shut or open only until the Sidebar is
// awake (its nav then carries data-sidebar-woke), when React keeps them. A group that starts folded
// is drawn open and marked (nav.tsx, foldedLook), so with no script every row stays in reach; this
// style hides the marked ones, and a kept choice after it wins. If the scripts fail and the sidebar
// never wakes, the style goes 1.5s after the load event, or at the first key or press before it
// wakes, so no row is lost.

/** The head script that draws the kept folds before the Sidebar wakes. */
export const sidebarFoldScript = (storageKey: string): string =>
  "(()=>{try{" +
  `const f=JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})||"{}"),r=["nav:not([data-sidebar-woke]) [data-sidebar-asleep-shut]{display:none!important}"];` +
  'for(const k in f){if(typeof f[k]!=="boolean")continue;' +
  'const s="nav:not([data-sidebar-woke]) [data-sidebar-fold=\\""+CSS.escape(k)+"\\"]";' +
  'r.push(s+(f[k]?"{display:none!important}":"{display:flex!important}"));}' +
  'if(r.length){const e=document.createElement("style");e.textContent=r.join("");document.head.appendChild(e);' +
  // When the page's scripts fail, the sidebar never wakes: a moment after the page has loaded the
  // style gives the rows back, so every page stays in reach.
  'const g=()=>{if(!document.querySelector("nav[data-sidebar-woke]"))e.remove();};' +
  'addEventListener("load",()=>setTimeout(g,1500),{once:true});' +
  // and at once when a person reaches for something (a key, a press) before it has woken.
  'addEventListener("keydown",g,{once:true,capture:true});addEventListener("pointerdown",g,{once:true,capture:true});}' +
  "}catch(e){}})()";
