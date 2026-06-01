"""Pydantic request models.

These mirror the spec's v2 request bodies but make the server-computed amounts
(net_amount, tax_amount, total_amount, price_with_tax) OPTIONAL — the backend
computes them, which is exactly the convenience the wrapper provides. Validation
here reproduces the API's enums/required-field behaviour so the frontend gets
realistic errors.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

DocumentType = Literal[
    "invoice",
    "subscription",
    "pro_forma_invoice",
    "estimate",
    "sales_return",
    "purchase_return",
    "delivery_challan",
    "purchase",
    "purchase_order",
]
PartyType = Literal["customer", "vendor"]
ItemType = Literal["Product", "Service"]
PaymentMethod = Literal["cash", "card", "upi", "netBanking", "cheque", "emi"]


class AddressIn(BaseModel):
    addr_id_v2: Optional[str] = None
    address_line1: Optional[str] = ""
    address_line2: Optional[str] = ""
    city: Optional[str] = ""
    state: Optional[str] = None
    country: Optional[str] = "India"
    pincode: Optional[str] = ""


class PartyIn(BaseModel):
    id: str
    name: str
    type: PartyType = "customer"
    country_code: Optional[str] = "91"
    phone_number: Optional[str] = None
    company_name: Optional[str] = None
    email: Optional[str] = None
    gstin: Optional[str] = None
    billing_address: Optional[AddressIn] = None
    shipping_address: Optional[AddressIn] = None


class DocItemIn(BaseModel):
    id: str
    name: str
    item_type: ItemType = "Product"
    quantity: float
    unit_price: float
    tax_rate: float = 0.0
    cess_rate: float = 0.0
    discount_percent: Optional[float] = None
    discount_amount: Optional[float] = None
    hsn_code: Optional[str] = None
    unit: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None


class PaymentEntryIn(BaseModel):
    amount: float
    method: PaymentMethod = "cash"
    payment_date: Optional[str] = None  # DD-MM-YYYY
    notes: Optional[str] = None


class ChargeIn(BaseModel):
    id: int = 1
    name: str
    amount: float
    tax_rate: float = 0.0
    sac_code: Optional[str] = None
    type: Literal["charge", "deduction"] = "charge"


class CreateDocumentIn(BaseModel):
    document_type: DocumentType = "invoice"
    document_date: str  # DD-MM-YYYY
    party: PartyIn
    items: List[DocItemIn] = Field(min_length=1)
    serial_number: Optional[str] = None
    due_date: Optional[str] = None
    reference: Optional[str] = None
    notes: Optional[str] = None
    terms: Optional[str] = None
    extra_discount: float = 0.0
    round_off: bool = False
    payments: List[PaymentEntryIn] = Field(default_factory=list)
    charges_and_deductions: List[ChargeIn] = Field(default_factory=list)
    tds_id: Optional[int] = None
    tcs_id: Optional[int] = None
    einvoice: bool = False
    is_export: bool = False


class CreateCustomerIn(BaseModel):
    customer_id: str
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    gstin: Optional[str] = None
    company_name: Optional[str] = None
    dial_code: Optional[str] = "91"
    opening_balance: float = 0.0
    credit_limit: float = 0.0
    pan: Optional[str] = None
    notes: Optional[str] = None
    billing_address: List[AddressIn] = Field(default_factory=list)
    shipping_address: List[AddressIn] = Field(default_factory=list)


class CreateVendorIn(BaseModel):
    vendor_id: str
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    gstin: Optional[str] = None
    company_name: Optional[str] = None
    dial_code: Optional[str] = "91"
    opening_balance: float = 0.0
    pan: Optional[str] = None
    notes: Optional[str] = None
    billing_address: List[AddressIn] = Field(default_factory=list)
    shipping_address: List[AddressIn] = Field(default_factory=list)


class CreateProductIn(BaseModel):
    item_id: str
    name: str
    selling_price: float
    purchase_price: float = 0.0
    unit: Optional[str] = "OTH"
    hsn_code: Optional[str] = None
    tax_rate: float = 0.0
    cess_rate: float = 0.0
    item_type: ItemType = "Product"
    category: Optional[str] = None
    description: Optional[str] = None
    opening_stock: float = 0.0
    low_stock_alert: float = 0.0
    item_code: Optional[str] = None


class RecordPaymentIn(BaseModel):
    """Record a payment against a document (by hash_id or serial_number)."""
    doc_hash_id: Optional[str] = None
    serial_number: Optional[str] = None
    customer_id: Optional[str] = None
    amount: float
    method: PaymentMethod = "cash"
    payment_date: Optional[str] = None
    notes: Optional[str] = None
