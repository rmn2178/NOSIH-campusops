from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Building(Base):
    __tablename__ = "buildings"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    total_floors: Mapped[int] = mapped_column(Integer, default=0)
    x_offset: Mapped[float] = mapped_column(Float, default=0)
    z_offset: Mapped[float] = mapped_column(Float, default=0)

    floors: Mapped[list["Floor"]] = relationship(back_populates="building", cascade="all, delete-orphan")


class Floor(Base):
    __tablename__ = "floors"
    __table_args__ = (
        UniqueConstraint("building_id", "floor_number", name="uq_floor_building_number"),
        UniqueConstraint("code", name="uq_floor_code"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id"), index=True)
    floor_number: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(10))
    elevation_y: Mapped[float] = mapped_column(Float)

    building: Mapped[Building] = relationship(back_populates="floors")


class DistributionBoard(Base):
    __tablename__ = "distribution_boards"
    __table_args__ = (UniqueConstraint("building_id", "floor_number", "wing", name="uq_board_floor_wing"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id"), index=True)
    floor_number: Mapped[int] = mapped_column(Integer)
    wing: Mapped[str] = mapped_column(String(10))
    breaker_rating_amps: Mapped[int] = mapped_column(Integer, default=63)
    status: Mapped[str] = mapped_column(String(20), default="ONLINE", index=True)


class Room(Base):
    __tablename__ = "rooms"
    __table_args__ = (UniqueConstraint("building_id", "floor_id", "room_number_on_floor", name="uq_room_position"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    zero_index_alias: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id"), index=True)
    floor_id: Mapped[int] = mapped_column(ForeignKey("floors.id"), index=True)
    room_number_on_floor: Mapped[int] = mapped_column(Integer)
    capacity: Mapped[int] = mapped_column(Integer, default=60)
    distribution_board_id: Mapped[int] = mapped_column(ForeignKey("distribution_boards.id"), index=True)
    visual_state: Mapped[str] = mapped_column(String(20), default="HEALTHY", index=True)
    home_class_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    x_pos: Mapped[float] = mapped_column(Float, default=0)
    y_pos: Mapped[float] = mapped_column(Float, default=0)
    z_pos: Mapped[float] = mapped_column(Float, default=0)

    floor: Mapped[Floor] = relationship()
    distribution_board: Mapped[DistributionBoard] = relationship()


class Lab(Base):
    __tablename__ = "labs"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    lab_category: Mapped[str] = mapped_column(String(20), index=True)
    capacity: Mapped[int] = mapped_column(Integer, default=60)
    distribution_board_id: Mapped[int] = mapped_column(ForeignKey("distribution_boards.id"))
    visual_state: Mapped[str] = mapped_column(String(20), default="HEALTHY", index=True)
    x_pos: Mapped[float] = mapped_column(Float, default=0)
    y_pos: Mapped[float] = mapped_column(Float, default=0)
    z_pos: Mapped[float] = mapped_column(Float, default=0)

    distribution_board: Mapped[DistributionBoard] = relationship()


class Canteen(Base):
    __tablename__ = "canteens"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    specialty: Mapped[str] = mapped_column(String(120))
    visual_state: Mapped[str] = mapped_column(String(20), default="HEALTHY", index=True)
    current_queue_length: Mapped[int] = mapped_column(Integer, default=0)
    seating_capacity: Mapped[int] = mapped_column(Integer, default=80)
    active_menu_json: Mapped[str] = mapped_column(Text, default="[]")
    disabled_menu_items_json: Mapped[str] = mapped_column(Text, default="[]")
    x_pos: Mapped[float] = mapped_column(Float, default=0)
    y_pos: Mapped[float] = mapped_column(Float, default=0)
    z_pos: Mapped[float] = mapped_column(Float, default=0)


class BillBot(Base):
    __tablename__ = "bill_bots"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    location_description: Mapped[str] = mapped_column(String(200))
    parent_canteen_id: Mapped[int | None] = mapped_column(ForeignKey("canteens.id"), nullable=True)
    nearest_fallback_bot_id: Mapped[int | None] = mapped_column(ForeignKey("bill_bots.id"), nullable=True)
    visual_state: Mapped[str] = mapped_column(String(20), default="HEALTHY", index=True)
    paper_roll_pct: Mapped[int] = mapped_column(Integer, default=100)
    thermal_head_health_pct: Mapped[int] = mapped_column(Integer, default=100)
    active_queue_count: Mapped[int] = mapped_column(Integer, default=0)
    rerouted_to_bot_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_bill_printed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    x_pos: Mapped[float] = mapped_column(Float, default=0)
    y_pos: Mapped[float] = mapped_column(Float, default=0)
    z_pos: Mapped[float] = mapped_column(Float, default=0)

    parent_canteen: Mapped[Canteen | None] = relationship()
    nearest_fallback_bot: Mapped["BillBot | None"] = relationship(remote_side=[id])


class Asset(Base):
    __tablename__ = "assets"
    __table_args__ = (UniqueConstraint("parent_space_type", "parent_space_code", "slot_index", "asset_type", name="uq_asset_slot"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_code: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    asset_type: Mapped[str] = mapped_column(String(30), index=True)
    parent_space_type: Mapped[str] = mapped_column(String(20), index=True)
    parent_space_code: Mapped[str] = mapped_column(String(30), index=True)
    slot_index: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="OK", index=True)
    sku_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    installed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failure_count_30d: Mapped[int] = mapped_column(Integer, default=0)
