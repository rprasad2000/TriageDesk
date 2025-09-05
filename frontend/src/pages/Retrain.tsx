import { useMutation } from "@tanstack/react-query";
import { api } from "../api";

export default function Retrain() {
  const mRetrain = useMutation({
    mutationFn: () => api.post("/retrain").then(r => r.data),
  });

  return (
    <div>
      <h2>Retrain</h2>
      <button onClick={() => mRetrain.mutate()} disabled={mRetrain.isPending}>
        {mRetrain.isPending ? "Retraining..." : "Retrain with Feedback"}
      </button>
      {mRetrain.data && <pre>{JSON.stringify(mRetrain.data, null, 2)}</pre>}
    </div>
  );
}
