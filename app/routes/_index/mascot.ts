// JAZZ, the animated assistant character (inline SVG, animated by jazz.css).
export const MASCOT_SVG = `<svg id="bot" viewBox="0 0 420 480" role="img" aria-label="JAZZ, a friendly assistant robot with a headset, waving">
        <defs>
          <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3e0bd"/><stop offset=".55" stop-color="#cfa877"/><stop offset="1" stop-color="#8f6b45"/></linearGradient>
          <linearGradient id="shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a382a"/><stop offset="1" stop-color="#1f1710"/></linearGradient>
          <linearGradient id="visor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f0a06"/><stop offset="1" stop-color="#1c130c"/></linearGradient>
          <radialGradient id="jet" cx=".5" cy="0" r="1"><stop offset="0" stop-color="#ffd89a" stop-opacity=".95"/><stop offset="1" stop-color="#e8a96b" stop-opacity="0"/></radialGradient>
          <radialGradient id="eg" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffd89a" stop-opacity=".55"/><stop offset="1" stop-color="#ffd89a" stop-opacity="0"/></radialGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        <ellipse class="shadow" cx="210" cy="452" rx="90" ry="12" fill="#000" opacity=".4"/>

        <!-- things that orbit JAZZ -->
        <g class="orbit" opacity=".95">
          <g transform="translate(60 200)"><g class="item"><rect x="-17" y="-15" width="34" height="30" rx="5" fill="url(#gold)"/><path d="M-17-5h34M0-15v10" stroke="#5b3f2a" stroke-width="2.4"/></g></g>
          <g transform="translate(362 150)"><g class="item b"><circle r="19" fill="url(#gold)"/><text y="7" text-anchor="middle" font-size="21" font-weight="700" fill="#5b3f2a" font-family="Inter,Arial">₹</text></g></g>
          <g transform="translate(345 330)"><g class="item c"><circle r="16" fill="#8fd08a"/><path d="M-7 0 -2 5 8-5" stroke="#10270f" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></g>
        </g>
        <g fill="#f3e0bd"><path class="spark" d="M70 90l5 12 12 5-12 5-5 12-5-12-12-5 12-5z"/><path class="spark b" d="M350 60l4 9 9 4-9 4-4 9-4-9-9-4 9-4z"/><path class="spark c" d="M380 250l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/></g>

        <g class="floatY">
          <!-- jet flame -->
          <ellipse class="jet" cx="210" cy="410" rx="46" ry="36" fill="url(#jet)"/>

          <!-- left arm -->
          <g class="armL"><rect x="118" y="272" width="26" height="82" rx="13" fill="url(#gold)"/><circle cx="131" cy="358" r="16" fill="url(#gold)"/></g>

          <!-- body -->
          <rect x="190" y="228" width="40" height="30" rx="8" fill="#2a1f16"/>
          <rect x="138" y="248" width="144" height="146" rx="50" fill="url(#gold)"/>
          <rect x="152" y="258" width="116" height="22" rx="11" fill="#fff" opacity=".18"/>
          <rect x="160" y="284" width="100" height="66" rx="18" fill="#1a120c"/>
          <polyline class="beat" points="168,318 188,318 196,300 206,336 216,310 224,318 252,318" fill="none" stroke="#ffd89a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="210" cy="372" r="12" fill="#2a1f16"/><text x="210" y="377" text-anchor="middle" font-size="14" font-weight="800" fill="#ffd89a" font-family="Inter,Arial">J</text>

          <!-- waving right arm (raised) -->
          <g class="wave"><rect x="276" y="272" width="26" height="82" rx="13" fill="url(#gold)"/><circle cx="289" cy="358" r="17" fill="url(#gold)"/><g fill="#8f6b45"><rect x="279" y="368" width="5" height="9" rx="2.5"/><rect x="287" y="371" width="5" height="9" rx="2.5"/><rect x="295" y="368" width="5" height="9" rx="2.5"/></g></g>

          <!-- head -->
          <line x1="210" y1="100" x2="210" y2="66" stroke="url(#gold)" stroke-width="6" stroke-linecap="round"/>
          <circle class="ant" cx="210" cy="54" r="12" fill="#ffd89a"/>
          <circle cx="210" cy="54" r="12" fill="url(#gold)"/>
          <circle cx="206" cy="50" r="3.5" fill="#fff" opacity=".8"/>
          <path d="M104 150C104 62 316 62 316 150" fill="none" stroke="url(#gold)" stroke-width="9" stroke-linecap="round"/>
          <rect x="108" y="98" width="204" height="152" rx="66" fill="url(#shell)" stroke="#d9b98a" stroke-opacity=".45" stroke-width="1.5"/>
          <rect x="126" y="116" width="168" height="112" rx="48" fill="url(#visor)"/>
          <ellipse cx="170" cy="126" rx="40" ry="6" fill="#fff" opacity=".07"/>
          <circle cx="106" cy="174" r="19" fill="url(#gold)"/><circle cx="106" cy="174" r="9" fill="#2a1f16"/>
          <circle cx="314" cy="174" r="19" fill="url(#gold)"/><circle cx="314" cy="174" r="9" fill="#2a1f16"/>
          <path d="M313 192C330 240 296 246 270 240" fill="none" stroke="#2a1f16" stroke-width="6" stroke-linecap="round"/>
          <circle cx="266" cy="240" r="8" fill="url(#gold)"/>
          <!-- eyes (follow the cursor) -->
          <g id="eyes" class="pupil"><ellipse cx="173" cy="167" rx="38" ry="44" fill="url(#eg)"/><ellipse cx="247" cy="167" rx="38" ry="44" fill="url(#eg)"/>
            <rect class="eyeL" x="156" y="146" width="34" height="42" rx="15" fill="#ffd89a"/>
            <rect class="eyeR" x="230" y="146" width="34" height="42" rx="15" fill="#ffd89a"/>
            <circle cx="170" cy="160" r="5" fill="#fff" opacity=".85"/><circle cx="244" cy="160" r="5" fill="#fff" opacity=".85"/>
          </g>
          <circle cx="146" cy="204" r="9" fill="#ff9f7a" opacity=".28"/><circle cx="274" cy="204" r="9" fill="#ff9f7a" opacity=".28"/>
          <path class="talk" d="M190 206Q210 226 230 206" fill="none" stroke="#ffd89a" stroke-width="5" stroke-linecap="round"/>
        </g>
      </svg>`;
