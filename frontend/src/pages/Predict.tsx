import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { predict, feedback } from '../api'

export default function Predict(){
  const [text, setText] = useState('Login page throws exception when submitting invalid email format.')
  const [topk, setTopk] = useState(5)
  const m = useMutation({ mutationFn: ()=> predict(text, topk) })
  const mFb = useMutation({ mutationFn: (p:{true_label:string})=> feedback(text, p.true_label) })

  return (
    <div className="grid">
      <div className="card">
        <h2>Predict</h2>
        <form onSubmit={(e)=>{e.preventDefault(); m.mutate();}}>
          <label>Defect text</label>
          <textarea rows={6} value={text} onChange={e=>setText(e.target.value)} />
          <label>Top-K similar</label>
          <input type="number" value={topk} onChange={e=>setTopk(parseInt(e.target.value||'1')||1)} />
          <button disabled={m.isPending}>{m.isPending?'Classifying…':'Classify'}</button>
        </form>
        {m.isError && <p style={{color:'crimson'}}>Error: {(m.error as any)?.message}</p>}
      </div>

      {m.data && (
        <div className="card">
          <h3>Result</h3>
          <div><b>Prediction:</b> {m.data.prediction}</div>
          <div><b>Confidence:</b> {(m.data.confidence*100).toFixed(1)}%</div>
          <div style={{marginTop:8}}><b>Similar tickets</b></div>
          <div>
            {m.data.recommendations.map((r,idx)=> (
              <div className="rec" key={idx}>
                <div><b>{r.issue_key || '(no key)'}</b> — <i>{r.label || '-'}</i></div>
                <div>{r.summary}</div>
                {!!r.url && <div><a href={r.url} target="_blank">open</a></div>}
                <small className="mono">similarity: {r.similarity.toFixed(3)}</small>
              </div>
            ))}
          </div>
          <div style={{marginTop:12, display:'flex', gap:8}}>
            <input id="fb" placeholder="True label…" />
            <button className="secondary" onClick={()=>{
              const el = document.getElementById('fb') as HTMLInputElement
              if(el?.value){ mFb.mutate({true_label: el.value}) }
            }}>Send feedback</button>
          </div>
          {mFb.isSuccess && <small>Thanks — feedback saved.</small>}
        </div>
      )}
    </div>
  )
}
