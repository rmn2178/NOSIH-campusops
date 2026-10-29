from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str | None = None
    department_code: str | None = None
    department: str | None = None
    year_number: int | None = Field(default=None, ge=1, le=3)
    academic_role: str | None = None


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    department_code: str | None
    year_number: int | None
    class_code: str | None
    home_room_code: str | None = None
    section_letter: str | None = None
    department: str | None = None
    academic_role: str | None = None
    section: str | None = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
