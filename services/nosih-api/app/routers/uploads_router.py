import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.auth import get_current_user
from app.config import settings
from app.models import User

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


@router.post("/image", status_code=201)
@router.post("/complaint-images", status_code=201)
async def upload_image(user: Annotated[User, Depends(get_current_user)], file: UploadFile = File(...)) -> dict[str, str]:
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WebP images are accepted")
    content = await file.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 5 MB limit")
    directory = Path(settings.upload_dir)
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4()}{ALLOWED_TYPES[file.content_type]}"
    (directory / filename).write_bytes(content)
    return {"id": filename, "image_url": f"/uploads/{filename}", "url": f"/uploads/{filename}", "content_type": file.content_type or "", "size_bytes": len(content)}
