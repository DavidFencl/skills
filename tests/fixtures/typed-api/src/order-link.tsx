// A link to an order page in the app: a route, not an API call.
export function OrderLink({ id }: { id: string }) {
  return <a href={`/orders/${id}`}>Order {id}</a>;
}
