import { http, type HttpResponse } from './http';
import type { NewOrder, OrderDto, Page, UserDto } from './dto';

const PREFIX = '/orders' as const;

// Declared return type, URL built from a constant.
export async function listRecentOrders(): Promise<Page<OrderDto>> {
  const response = await http.get(`${PREFIX}/recent`);
  return response.data as Page<OrderDto>;
}

// Type argument on the call, return type inferred.
export async function getOrder(id: string) {
  const response = await http.get<OrderDto>(`${PREFIX}/${id}`);
  return response.data;
}

// The URL is a constant identifier and the method is POST.
export function createOrder(input: NewOrder) {
  return http.post<OrderDto>(PREFIX, input).then((response) => response.data);
}

// The function returns the client's wrapper; the body is its data.
export const getProfile = (): Promise<HttpResponse<UserDto>> => http.get('/me');

// Plain fetch: the body has no type.
export async function getRawThings() {
  const response = await fetch('/api/raw/things');
  return response.json();
}
