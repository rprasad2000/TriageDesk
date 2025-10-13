# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers.ml_router import router as ml_router

app = FastAPI(title="Defect Classifier & Recommender")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

app.include_router(ml_router)

# Optional: health
@app.get("/health")
def health():
    return {"status":"ok"}