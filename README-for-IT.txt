Slate Sorter - hosting notes for IT
===================================

What it is
  A static web page (HTML, JavaScript, WebAssembly). No server-side code, no database,
  no sign-in. All scanning, reading and sorting happens inside the user's browser.
  Scanned slates are never uploaded: the page makes no network requests except to load
  its own files from this folder.

How to host
  1. Copy this whole folder, unchanged, to any static web host or internal web server
     (IIS, Apache, nginx, SharePoint-hosted static site, Azure Static Web Apps, etc.).
  2. Serve it over HTTPS. Browsers only allow the "save into a folder" feature on HTTPS
     pages (or http://localhost). Over plain HTTP the page still works but falls back to
     downloading a ZIP file.
  3. Make sure these file types are served with these MIME types (most servers already do;
     IIS often needs .mjs and .wasm added):
        .mjs   ->  text/javascript
        .js    ->  text/javascript
        .wasm  ->  application/wasm
     A wrong type for .mjs stops the page from loading at all.

Browsers
  Microsoft Edge or Google Chrome on Windows (saves straight into a chosen folder).
  Other browsers work in ZIP-download mode.

What users give it
  One PDF (a single slate or a whole stack), or one ZIP file containing separate slate
  files (PDF, JPG, PNG). ZIPs are opened inside the browser; nothing is uploaded.

Size
  About 14 MB in total; downloaded once per visit, then served from the browser cache.

Files
  index.html          the page
  slate-core.js       slate reading logic
  lib/                third-party engines, all open source:
                        Tesseract.js 5.1.1 (Apache-2.0) - text recognition
                        zxing-wasm 1.3.4 (MIT)          - barcode reading
                        PDF.js 4.10.38 (Apache-2.0)     - drawing PDF pages
                        pdf-lib 1.17.1 (MIT)            - writing one PDF per slate
                        fflate 0.8.3 (MIT)              - reading and writing ZIP files
  lib/lang/eng-traineddata.wasm   English text-recognition data (gzip data; the .wasm
                                  name is only so every host serves it without extra setup)
