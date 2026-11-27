# Changelog

## 0.1.0

- First version, built from the MCP server template: six tools for the parts
  of Bilinfo that Bilinfo documents for integrators.
- Listing API (HTTP Basic): `bilinfo_list_vehicles` lists a dealer's vehicles
  for sale with filters (make, model, fuel, price range, model year, free
  text), sorting and paging; `bilinfo_get_vehicle` returns one listing with
  every field Bilinfo sends; `bilinfo_stock_overview` counts listings and
  cars, adds up asking prices per price type and groups cars by make and by
  days since they were created in Bilinfo.
- Shared Services (OAuth 2.0, client credentials): `bilinfo_find_dealer`
  looks a dealer up by CVR number, and `bilinfo_list_users` shows the users
  of the dealer the instance is set up for.
- Case Plugin: `bilinfo_report_application_status` reports the status of a
  finance or insurance application to the case in Bilinfo. It is the one
  change the server can make: off by default, logged before it is sent, sent
  once, and out of reach of the read tools.
- Not included, because Bilinfo does not publish their requests: the Car API
  (create and edit cars) and the Model Catalog. The Case Plugin's sales
  contract is a PDF file and is not passed on.
- Nothing is stored: every tool call asks Bilinfo and passes the answer on.
  No answer is kept between calls, and neither is the access token.
- No credential is refused for its form: any length, with spaces, with æ, ø
  and å, or with words that also stand in the server's own texts. Secrets
  that can be told from ordinary text are redacted as whole values and
  checked for in every output.
- Tool titles and descriptions, errors and refusals are in Danish.
- Gateway (`./gateway`) in the template's shape: explicit credentials,
  instance policy from the host, call scopes, the sink check and a frozen
  tool catalog with the upstream request of each tool.
