"""Typed tool inputs exposed through MCP JSON schemas."""
from __future__ import annotations

from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class InvoiceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    quantity: float = Field(gt=0)
    unit_price: float = Field(ge=0, description="Tax-exclusive unit price.")
    tax_rate: float = Field(default=18, ge=0)
    cess_rate: float = Field(default=0, ge=0, le=100)
    discount_percent: float = Field(default=0, ge=0, le=100)
    item_type: Literal["Product", "Service"] = "Product"
    item_id: str | None = Field(default=None, max_length=100)
    unit: str | None = Field(default=None, max_length=50)
    hsn_code: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=1000)


class BankCredit(BaseModel):
    """One incoming credit (deposit) line parsed from a bank statement.

    The MCP host (e.g. Claude Desktop) reads the statement PDF/CSV and passes the
    credit lines here; the Swipe server does not parse files itself.
    """

    # Be lenient with model-generated args: ignore unknown keys instead of
    # rejecting the whole batch, and accept the reference under common names.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    amount: float = Field(gt=0, description="Deposit amount in INR (credits only; skip debits).")
    narration: str = Field(
        min_length=1,
        max_length=500,
        description="Raw bank narration/description, e.g. 'NEFT CR-...-ACME INDUSTRIES PVT LTD-INV 06'.",
    )
    date: str | None = Field(
        default=None, description="Credit date as DD-MM-YYYY or YYYY-MM-DD, if known."
    )
    reference: str | None = Field(
        default=None,
        max_length=100,
        validation_alias=AliasChoices("reference", "ref", "utr", "ref_no", "reference_number"),
        description="Bank reference/UTR (also accepts 'ref'), if parsed separately from the narration.",
    )


class BankDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_number: str = Field(min_length=1, max_length=100)
    ifsc: str = Field(min_length=1, max_length=30)
    bank_name: str = Field(min_length=1, max_length=200)
    branch: str = Field(min_length=1, max_length=200)


PaymentMethod = Literal[
    "cash",
    "upi",
    "card",
    "cheque",
    "net_banking",
    "emi",
]
