import { useState, useRef, useEffect } from 'react'

// ─── Design Tokens ────────────────────────────────────────────────────────────
const C = {
  bg: '#1e1e1e', bgPanel: '#252526', bgInput: '#2d2d2d', border: '#3e3e3e',
  amber: '#f0a500', amberFade: '#3a2800', green: '#22c55e', red: '#ef4444',
  muted: '#999999', text: '#e8e8e8', scrollbar: '#4a4a4a',
  font: "'JetBrains Mono','Fira Code','Cascadia Code','Courier New',monospace",
}
const API_URL    = 'https://api.anthropic.com/v1/messages'
const MODEL      = 'claude-sonnet-4-20250514'
const MAX_TOK    = 1000
const CONNECT_MS = 15000
const CHUNK_MS   = 22000

// ─── System Prompts ───────────────────────────────────────────────────────────
const SYSTEM_A = `You are an OST (Objective-Strategy-Tactics) Framer. Structure the given strategic thesis into exactly these markdown sections with no preamble:

## Objective
## Strategy
## Tactics
(5-8 bullet items)
## Load-Bearing Assumptions
(4-6 numbered items)
## Key Uncertainties
(3-5 numbered items)

Output only these sections. No preamble, no conclusion.`

const SYSTEM_B = `You are a Steelman Advocate. Given an OST Frame analysis, make the strongest honest case for the strategy. Output exactly these sections:

## Strongest Supporting Evidence
## Core Strategic Advantages
## Why Critics Are Wrong
## Conditions For Success

No hedging. Make the strongest possible honest case.`

const SYSTEM_C = `You are a Red Team Stress Tester. Given an OST Frame and a Steelman case, rigorously stress test the strategy. Output exactly these sections:

## Fatal Flaw Analysis
(mechanism-based critique with historical analogy for each flaw)
## Assumption Autopsy
(rate each assumption HIGH/MEDIUM/LOW risk)
## Steelman Rebuttal
## Worst-Case Scenario
## Red Team Verdict

Ground every critique in mechanism, not assertion.`

const SYSTEM_D = `You are a Strategic Synthesiser. Given compact summaries of OST Frame, Steelman, and Stress Test analyses plus any parked thoughts, produce a final synthesis. Output exactly these sections:

## ACH Evidence Weighting
(markdown table with columns: Evidence | Supports | Undermines | Weight H/M/L)
## Decision Landscape
## Recommendation
(bold the verdict: **COMMIT**, **WAIT**, or **ABANDON**)
## Minimum Viable Signal
(specific observable signals within 30-90 days)
## Next Session Prompts
(5 numbered questions for the next strategic review)`

// ─── CSS Injection ────────────────────────────────────────────────────────────
;(function injectCSS() {
  const style = document.createElement('style')
  style.textContent = `
    html, body, #root { height: 100%; background: #1e1e1e; color: #e8e8e8; margin: 0; font-size: 14px; }
    body { overflow: hidden; display: block !important; place-items: unset !important; }
    * { box-sizing: border-box; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #252526; }
    ::-webkit-scrollbar-thumb { background: #4a4a4a; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #5a5a5a; }
    textarea:focus, input:focus { outline: 1px solid #f0a500 !important; }
    button { font-family: 'JetBrains Mono','Fira Code','Cascadia Code','Courier New',monospace; }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
    .cursor-blink::after {
      content: '▌';
      color: #f0a500;
      animation: blink 1s step-end infinite;
      margin-left: 2px;
    }
  `
  document.head.appendChild(style)
})()

// ─── Constants ────────────────────────────────────────────────────────────────
const AGENT_META = {
  A: { label: 'AGENT A', title: 'OST FRAME' },
  B: { label: 'AGENT B', title: 'STEELMAN' },
  C: { label: 'AGENT C', title: 'STRESS TEST' },
  D: { label: 'AGENT D', title: 'SYNTHESIS' },
}
const SYSTEMS   = { A: SYSTEM_A, B: SYSTEM_B, C: SYSTEM_C, D: SYSTEM_D }
const AGENT_IDS = ['A', 'B', 'C', 'D']

const INITIAL_AGENTS = {
  A: { output: '', status: 'idle', tokens: { in: 0, out: 0 }, error: null },
  B: { output: '', status: 'idle', tokens: { in: 0, out: 0 }, error: null },
  C: { output: '', status: 'idle', tokens: { in: 0, out: 0 }, error: null },
  D: { output: '', status: 'idle', tokens: { in: 0, out: 0 }, error: null },
}

// ─── Btn Helper ───────────────────────────────────────────────────────────────
function Btn({ children, onClick, disabled, style: s = {}, hoverStyle = {} }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        fontFamily: C.font,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.05em',
        padding: '5px 10px',
        background: C.bgInput,
        color: C.text,
        border: `1px solid ${C.border}`,
        borderRadius: 3,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'border-color 0.15s, color 0.15s, background 0.15s',
        ...(hovered && !disabled ? hoverStyle : {}),
        ...s,
      }}
    >
      {children}
    </button>
  )
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusStyle(status) {
  switch (status) {
    case 'streaming': return { color: '#f0a500', background: '#3a2800' }
    case 'done':      return { color: '#22c55e', background: '#052e16' }
    case 'error':     return { color: '#ef4444', background: '#2d0707' }
    default:          return { color: '#555555', background: '#1a1a1a' }
  }
}

function statusLabel(status) {
  switch (status) {
    case 'streaming': return 'STREAMING'
    case 'done':      return 'DONE'
    case 'error':     return 'ERROR'
    default:          return 'IDLE'
  }
}

// ─── AgentPanel ───────────────────────────────────────────────────────────────
function AgentPanel({ agentId, agent, onRetry, retryDisabled, copyFlash, onCopy }) {
  const meta = AGENT_META[agentId]
  const ss   = statusStyle(agent.status)

  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderRadius: 4,
      background: C.bgPanel,
      overflow: 'hidden',
      marginTop: 16,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: `1px solid ${C.border}`,
        background: C.bgInput,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: C.font, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: C.amber }}>
            [{meta.label}]
          </span>
          <span style={{ fontFamily: C.font, fontSize: 11, color: C.muted, letterSpacing: '0.06em' }}>
            — {meta.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: C.font, fontSize: 11, color: C.muted }}>
            in:{agent.tokens.in} out:{agent.tokens.out}
          </span>
          <span
            className={agent.status === 'streaming' ? 'cursor-blink' : ''}
            style={{
              fontFamily: C.font,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              padding: '2px 7px',
              borderRadius: 3,
              ...ss,
            }}
          >
            {statusLabel(agent.status)}
          </span>
        </div>
      </div>

      {/* Output */}
      <div style={{ minHeight: 200, maxHeight: 400, overflowY: 'auto', padding: '12px 14px' }}>
        {agent.output ? (
          <pre style={{
            margin: 0,
            fontFamily: C.font,
            fontSize: 13,
            lineHeight: 1.6,
            color: '#f0e6c8',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {agent.output}
          </pre>
        ) : agent.status === 'idle' ? (
          <span style={{ fontFamily: C.font, fontSize: 11, color: C.muted }}>awaiting input...</span>
        ) : null}
        {agent.error && (
          <div style={{
            marginTop: 8,
            padding: '8px 10px',
            background: '#2d0707',
            border: `1px solid ${C.red}`,
            borderRadius: 3,
            fontFamily: C.font,
            fontSize: 11,
            color: C.red,
            whiteSpace: 'pre-wrap',
          }}>
            ERROR: {agent.error}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 12px',
        borderTop: `1px solid ${C.border}`,
        background: C.bgInput,
      }}>
        <Btn
          onClick={onCopy}
          disabled={!agent.output}
          hoverStyle={{ borderColor: C.amber, color: C.amber }}
        >
          {copyFlash ? 'COPIED ✓' : 'COPY CHECKPOINT'}
        </Btn>
        <Btn
          onClick={onRetry}
          disabled={retryDisabled}
          hoverStyle={{ borderColor: C.amber, color: C.amber }}
        >
          RETRY FROM HERE ↺
        </Btn>
      </div>
    </div>
  )
}

// ─── StrategicOrient ──────────────────────────────────────────────────────────
function StrategicOrient() {
  const [tab, setTab]                       = useState(0)
  const [apiKey, setApiKey]                 = useState(import.meta.env.VITE_ANTHROPIC_API_KEY ?? '')
  const [thesis, setThesis]                 = useState('')
  const [parkedThoughts, setParkedThoughts] = useState('')
  const [agents, setAgents]                 = useState(INITIAL_AGENTS)
  const [copyFlash, setCopyFlash]           = useState(null)
  const [keyVisible, setKeyVisible]         = useState(!import.meta.env.VITE_ANTHROPIC_API_KEY)

  const genRef      = useRef({ A: 0, B: 0, C: 0, D: 0 })
  const outputsRef  = useRef({ A: '', B: '', C: '', D: '' })
  const chainGenRef = useRef(0)
  const parkedRef   = useRef('')

  useEffect(() => { parkedRef.current = parkedThoughts }, [parkedThoughts])

  // ── setAgent ───────────────────────────────────────────────────────────────
  const setAgent = (id, patch) =>
    setAgents(prev => ({
      ...prev,
      [id]: typeof patch === 'function' ? patch(prev[id]) : { ...prev[id], ...patch },
    }))

  // ── runStream ──────────────────────────────────────────────────────────────
  async function runStream(agentId, systemPrompt, userMessage) {
    const myGen = ++genRef.current[agentId]
    setAgent(agentId, { status: 'streaming', output: '', tokens: { in: 0, out: 0 }, error: null })

    const controller   = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_MS)

    let res
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOK,
          stream: true,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: controller.signal,
      })
      clearTimeout(connectTimer)
    } catch (err) {
      clearTimeout(connectTimer)
      if (genRef.current[agentId] !== myGen) return null
      setAgent(agentId, { status: 'error', error: err.message })
      return null
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      if (genRef.current[agentId] !== myGen) return null
      setAgent(agentId, { status: 'error', error: `HTTP ${res.status}: ${errText}` })
      return null
    }

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer      = ''
    let accumulated = ''
    let chunkTimer  = setTimeout(() => controller.abort(), CHUNK_MS)

    try {
      while (true) {
        const { done, value } = await reader.read()
        clearTimeout(chunkTimer)

        if (genRef.current[agentId] !== myGen) { reader.cancel(); return null }
        if (done) break

        chunkTimer = setTimeout(() => controller.abort(), CHUNK_MS)
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const evt = JSON.parse(data)
            if (evt.type === 'message_start') {
              setAgent(agentId, prev => ({
                ...prev,
                tokens: { ...prev.tokens, in: evt.message?.usage?.input_tokens ?? 0 },
              }))
            } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              accumulated += evt.delta.text
              setAgent(agentId, { output: accumulated })
            } else if (evt.type === 'message_delta') {
              setAgent(agentId, prev => ({
                ...prev,
                tokens: { ...prev.tokens, out: evt.usage?.output_tokens ?? 0 },
              }))
            }
          } catch {
            // ignore partial JSON lines
          }
        }
      }
    } catch (err) {
      clearTimeout(chunkTimer)
      if (genRef.current[agentId] !== myGen) return null
      setAgent(agentId, { status: 'error', error: err.message })
      return null
    }

    clearTimeout(chunkTimer)
    if (genRef.current[agentId] !== myGen) return null

    outputsRef.current[agentId] = accumulated
    setAgent(agentId, { status: 'done' })
    return accumulated
  }

  // ── buildUserMessage ───────────────────────────────────────────────────────
  function buildUserMessage(agentId) {
    const compact = s => s.slice(0, 800)
    switch (agentId) {
      case 'A':
        return `Analyse this strategic thesis:\n\n${thesis}`
      case 'B':
        return `OST FRAME ANALYSIS:\n\n${outputsRef.current.A}\n\nMake the strongest steelman case.`
      case 'C':
        return `OST FRAME:\n\n${outputsRef.current.A}\n\n---\nSTEELMAN:\n\n${outputsRef.current.B}\n\nStress test.`
      case 'D': {
        const parked = parkedRef.current
        return [
          `OST FRAME SUMMARY:\n\n${compact(outputsRef.current.A)}`,
          `\n\n---\nSTEELMAN SUMMARY:\n\n${compact(outputsRef.current.B)}`,
          `\n\n---\nSTRESS TEST SUMMARY:\n\n${compact(outputsRef.current.C)}`,
          parked ? `\n\n---\nPARKED THOUGHTS:\n\n${parked}` : '',
          '\n\n---\nSynthesize the above into your final strategic analysis.',
        ].join('')
      }
      default: return ''
    }
  }

  // ── runChain ───────────────────────────────────────────────────────────────
  async function runChain(fromAgent = 'A') {
    const myChain = ++chainGenRef.current
    const order   = AGENT_IDS.slice(AGENT_IDS.indexOf(fromAgent))
    for (const id of order) {
      if (chainGenRef.current !== myChain) return
      const result = await runStream(id, SYSTEMS[id], buildUserMessage(id))
      if (result === null) return
    }
  }

  // ── Copy / Export ──────────────────────────────────────────────────────────
  function copyAgent(agentId) {
    navigator.clipboard.writeText(agents[agentId].output)
    setCopyFlash(agentId)
    setTimeout(() => setCopyFlash(null), 1500)
  }

  function buildExportMarkdown() {
    return [
      '# Strategic Orient — Session Export',
      '',
      `**Date:** ${new Date().toISOString().slice(0, 10)}`,
      '',
      '## Thesis',
      '',
      thesis,
      '',
      '---',
      '',
      '## Agent A — OST Frame',
      '',
      agents.A.output || '_No output_',
      '',
      '---',
      '',
      '## Agent B — Steelman',
      '',
      agents.B.output || '_No output_',
      '',
      '---',
      '',
      '## Agent C — Stress Test',
      '',
      agents.C.output || '_No output_',
      '',
      '---',
      '',
      '## Agent D — Synthesis',
      '',
      agents.D.output || '_No output_',
      '',
      '---',
      '',
      '## Parked Thoughts',
      '',
      parkedThoughts || '_None_',
    ].join('\n')
  }

  function exportSession() {
    navigator.clipboard.writeText(buildExportMarkdown())
    setCopyFlash('export')
    setTimeout(() => setCopyFlash(null), 1500)
  }

  // ── Retry disabled ─────────────────────────────────────────────────────────
  function retryDisabled(agentId) {
    switch (agentId) {
      case 'A': return false
      case 'B': return agents.A.status !== 'done'
      case 'C': return agents.B.status !== 'done'
      case 'D': return agents.C.status !== 'done'
      default:  return true
    }
  }

  // ── Tab config ─────────────────────────────────────────────────────────────
  const TABS = ['01 OST FRAME', '02 STEELMAN', '03 STRESS TEST', '04 SYNTHESIS', '05 CAPTURE']

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: C.bg,
      fontFamily: C.font,
      color: C.text,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* ── Fixed Header ─────────────────────────────────────────────────── */}
      <div style={{
        height: 56,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: `1px solid ${C.border}`,
        background: C.bgPanel,
      }}>
        <span style={{
          fontFamily: C.font,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: C.amber,
        }}>
          STRATEGIC ORIENT
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setKeyVisible(v => !v)}
            style={{
              fontFamily: C.font,
              fontSize: 10,
              color: C.muted,
              background: 'none',
              border: `1px solid ${C.border}`,
              borderRadius: 3,
              padding: '3px 7px',
              cursor: 'pointer',
              letterSpacing: '0.05em',
            }}
          >
            API KEY {keyVisible ? '▲' : '▼'}
          </button>
          {keyVisible && (
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-ant-..."
              style={{
                fontFamily: C.font,
                fontSize: 11,
                background: C.bgInput,
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                padding: '4px 8px',
                width: 220,
              }}
            />
          )}
        </div>

        <Btn
          onClick={() => runChain('A')}
          disabled={!thesis.trim() || !apiKey.trim()}
          style={{ fontSize: 12, padding: '6px 16px' }}
          hoverStyle={{ borderColor: C.amber, color: C.amber, background: C.amberFade }}
        >
          ANALYSE ▶
        </Btn>
      </div>

      {/* ── Fixed Tab Bar ─────────────────────────────────────────────────── */}
      <div style={{
        height: 40,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: `1px solid ${C.border}`,
        background: C.bgPanel,
      }}>
        {TABS.map((label, i) => (
          <button
            key={i}
            onClick={() => setTab(i)}
            style={{
              fontFamily: C.font,
              fontSize: 11,
              fontWeight: tab === i ? 700 : 400,
              letterSpacing: '0.06em',
              background: 'none',
              border: 'none',
              borderBottom: tab === i ? `2px solid ${C.amber}` : '2px solid transparent',
              color: tab === i ? C.amber : C.muted,
              padding: '0 16px',
              cursor: 'pointer',
              borderRadius: 0,
              transition: 'color 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Scrollable Content ────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {/* Tab 0 — OST Frame */}
        {tab === 0 && (
          <div>
            <label style={{
              display: 'block',
              fontFamily: C.font,
              fontSize: 11,
              color: C.muted,
              marginBottom: 6,
              letterSpacing: '0.06em',
            }}>
              STRATEGIC THESIS
            </label>
            <textarea
              value={thesis}
              onChange={e => setThesis(e.target.value)}
              placeholder="Enter your strategic thesis here..."
              style={{
                width: '100%',
                height: 140,
                background: C.bgInput,
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                padding: '10px 12px',
                fontFamily: C.font,
                fontSize: 12,
                lineHeight: 1.6,
                resize: 'vertical',
              }}
            />
            <AgentPanel
              agentId="A"
              agent={agents.A}
              onRetry={() => runChain('A')}
              retryDisabled={retryDisabled('A')}
              copyFlash={copyFlash === 'A'}
              onCopy={() => copyAgent('A')}
            />
          </div>
        )}

        {/* Tab 1 — Steelman */}
        {tab === 1 && (
          <div>
            {(agents.A.status === 'idle' || agents.A.status === 'streaming') && (
              <div style={{
                fontFamily: C.font,
                fontSize: 11,
                color: C.muted,
                marginBottom: 12,
                padding: '6px 10px',
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                background: C.bgInput,
              }}>
                waiting for agent A to complete...
              </div>
            )}
            <AgentPanel
              agentId="B"
              agent={agents.B}
              onRetry={() => runChain('B')}
              retryDisabled={retryDisabled('B')}
              copyFlash={copyFlash === 'B'}
              onCopy={() => copyAgent('B')}
            />
          </div>
        )}

        {/* Tab 2 — Stress Test */}
        {tab === 2 && (
          <AgentPanel
            agentId="C"
            agent={agents.C}
            onRetry={() => runChain('C')}
            retryDisabled={retryDisabled('C')}
            copyFlash={copyFlash === 'C'}
            onCopy={() => copyAgent('C')}
          />
        )}

        {/* Tab 3 — Synthesis */}
        {tab === 3 && (
          <AgentPanel
            agentId="D"
            agent={agents.D}
            onRetry={() => runChain('D')}
            retryDisabled={retryDisabled('D')}
            copyFlash={copyFlash === 'D'}
            onCopy={() => copyAgent('D')}
          />
        )}

        {/* Tab 4 — Capture */}
        {tab === 4 && (
          <div>
            <label style={{
              display: 'block',
              fontFamily: C.font,
              fontSize: 11,
              color: C.muted,
              marginBottom: 6,
              letterSpacing: '0.06em',
            }}>
              PARKED THOUGHTS
            </label>
            <textarea
              value={parkedThoughts}
              onChange={e => setParkedThoughts(e.target.value)}
              placeholder="Notes, concerns, tangents, questions to revisit..."
              style={{
                width: '100%',
                height: 200,
                background: C.bgInput,
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                padding: '10px 12px',
                fontFamily: C.font,
                fontSize: 12,
                lineHeight: 1.6,
                resize: 'vertical',
              }}
            />
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <Btn
                onClick={exportSession}
                style={{ fontSize: 12, padding: '6px 16px' }}
                hoverStyle={{ borderColor: C.amber, color: C.amber, background: C.amberFade }}
              >
                {copyFlash === 'export' ? 'COPIED ✓' : 'EXPORT SESSION →'}
              </Btn>
              <span style={{ fontFamily: C.font, fontSize: 11, color: C.muted }}>
                Copies full session markdown to clipboard
              </span>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  return <StrategicOrient />
}
