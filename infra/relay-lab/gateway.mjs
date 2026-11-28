/**
 * Un finto router per la verifica 3: ascolta sull'host le richieste di
 * mappatura delle porte che un endpoint manda al proprio gateway.
 *
 * Dentro una rete Docker il gateway è l'host stesso (l'indirizzo `.1` del
 * ponte), quindi una presa sull'host alla UDP 5351 riceve NAT-PMP e PCP, e una
 * alla 1900 iscritta al gruppo SSDP riceve l'M-SEARCH di UPnP.
 *
 * A NAT-PMP e PCP non risponde. A UPnP sì, quanto basta perché l'endpoint
 * arrivi a chiedere la porta: risponde all'M-SEARCH con l'indirizzo di una
 * descrizione IGD minima e accetta le chiamate SOAP, così che la richiesta
 * `AddPortMapping` arrivi con la porta interna dentro. Non mappa niente.
 *
 * Scrive una riga JSON per pacchetto o chiamata su stdout, finché non riceve SIGTERM.
 */

import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

const HTTP_PORT = 49152;
const SERVICE = "urn:schemas-upnp-org:service:WANIPConnection:1";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** L'indirizzo dell'host sulla stessa rete di chi ha chiesto: lì la sonda ci raggiunge. */
function localAddressFor(remote) {
  const toInt = (ip) => ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      const mask = toInt(address.netmask);
      if ((toInt(address.address) & mask) === (toInt(remote) & mask)) return address.address;
    }
  }
  return undefined;
}

function listen(port, setup) {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (message, remote) => {
    emit({
      toPort: port,
      from: remote.address,
      fromPort: remote.port,
      payload: message.toString("hex"),
    });
    const local = localAddressFor(remote.address);
    if (port === 1900 && message.toString("latin1").startsWith("M-SEARCH") && local !== undefined) {
      const reply = [
        "HTTP/1.1 200 OK",
        "CACHE-CONTROL: max-age=120",
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "USN: uuid:estia-relay-lab::urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        `LOCATION: http://${local}:${HTTP_PORT}/rootDesc.xml`,
        "SERVER: estia-relay-lab UPnP/1.1",
        "",
        "",
      ].join("\r\n");
      socket.send(reply, remote.port, remote.address);
    }
  });
  socket.on("error", (error) => {
    process.stderr.write(`porta ${port}: ${error.message}\n`);
  });
  socket.bind(port, "0.0.0.0", () => setup?.(socket));
}

listen(5351);
listen(1900, (socket) => {
  // Su ogni interfaccia IPv4, così da sentire anche i ponti di Docker.
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      try {
        socket.addMembership("239.255.255.250", address.address);
      } catch (error) {
        process.stderr.write(`SSDP su ${address.address}: ${error.message}\n`);
      }
    }
  }
});

const description = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>estia-relay-lab</friendlyName>
    <deviceList><device>
      <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
      <deviceList><device>
        <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
        <serviceList><service>
          <serviceType>${SERVICE}</serviceType>
          <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
          <controlURL>/ctl/IPConn</controlURL>
          <eventSubURL>/evt/IPConn</eventSubURL>
          <SCPDURL>/WANIPCn.xml</SCPDURL>
        </service></serviceList>
      </device></deviceList>
    </device></deviceList>
  </device>
</root>`;

// igd-next costruisce le richieste dagli argomenti «in» dello schema: senza, non chiama.
const mapping = [
  "NewRemoteHost",
  "NewExternalPort",
  "NewProtocol",
  "NewInternalPort",
  "NewInternalClient",
  "NewEnabled",
  "NewPortMappingDescription",
  "NewLeaseDuration",
];
const actions = {
  GetExternalIPAddress: [],
  AddPortMapping: mapping,
  AddAnyPortMapping: mapping,
  DeletePortMapping: ["NewRemoteHost", "NewExternalPort", "NewProtocol"],
};
const argument = (name) => `<argument><name>${name}</name><direction>in</direction></argument>`;
const scpd = `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>${Object.entries(actions)
    .map(
      ([name, args]) =>
        `<action><name>${name}</name><argumentList>${args.map(argument).join("")}</argumentList></action>`,
    )
    .join("")}</actionList>
  <serviceStateTable></serviceStateTable>
</scpd>`;

function soap(action, body) {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action}Response xmlns:u="${SERVICE}">${body}</u:${action}Response></s:Body></s:Envelope>`;
}

createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const action = (request.headers.soapaction ?? "").replace(/"/g, "").split("#")[1];
    const field = (name) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
    emit({
      upnp: request.method,
      path: request.url,
      from: request.socket.remoteAddress,
      action,
      internalPort:
        field("NewInternalPort") === undefined ? undefined : Number(field("NewInternalPort")),
      externalPort:
        field("NewExternalPort") === undefined ? undefined : Number(field("NewExternalPort")),
      protocol: field("NewProtocol"),
      internalClient: field("NewInternalClient"),
      leaseSeconds:
        field("NewLeaseDuration") === undefined ? undefined : Number(field("NewLeaseDuration")),
    });
    response.setHeader("Content-Type", 'text/xml; charset="utf-8"');
    if (request.url === "/rootDesc.xml") return response.end(description);
    if (request.url === "/WANIPCn.xml") return response.end(scpd);
    if (action === "GetExternalIPAddress") {
      return response.end(soap(action, "<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>"));
    }
    if (action === "AddAnyPortMapping") {
      return response.end(
        soap(action, `<NewReservedPort>${field("NewExternalPort") ?? 0}</NewReservedPort>`),
      );
    }
    return response.end(soap(action ?? "Unknown", ""));
  });
}).listen(HTTP_PORT, "0.0.0.0");

process.on("SIGTERM", () => process.exit(0));
