export enum OrderStatus {
  Placed = 'placed',
  Shipped = 'shipped',
  Delivered = 'delivered',
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export class OrderDto {
  id!: string;
  customerName!: string;
  status!: OrderStatus;
  createdAt!: Date;
  totalPrice!: number;
  isArchived?: boolean;
  lines!: { productName: string; quantity: number }[];
  shippingAddress!: AddressDto | null;

  get label(): string {
    return `${this.id} ${this.customerName}`;
  }

  describe(): string {
    return this.label;
  }
}

export interface AddressDto {
  street: string;
  city: string;
  countryCode: string;
}

export interface UserDto {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string;
  memberSince: string;
  role: 'admin' | 'member';
}

export interface NewOrder {
  customerName: string;
}
