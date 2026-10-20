import {
  Diagram,
  type DiagramMode,
  type DiagramPaper,
  type DiagramStylePreset,
  type DiagramViewport,
  SvgGraphDiagram,
} from '@zukhruf/diagram';

export type HomelabReferenceDiagramProps = {
  className: string;
  controls?: boolean;
  defaultMode?: DiagramMode;
  showHeader?: boolean;
  stylePreset?: DiagramStylePreset;
  title?: string | string[];
  viewport: DiagramViewport;
  paper?: DiagramPaper;
};

export function HomelabReferenceDiagram({
  className,
  controls = false,
  defaultMode = 'static',
  showHeader = false,
  stylePreset = 'sketch',
  title = ['Homelab K3s reference', 'Zero-trust service platform'],
  viewport,
  paper = true,
}: HomelabReferenceDiagramProps) {
  return (
    <SvgGraphDiagram
      title={title}
      defaultMode={defaultMode}
      controls={controls}
      showHeader={showHeader}
      stylePreset={stylePreset}
      className={className}
      viewport={viewport}
      paper={paper}
    >
      <Diagram.Box
        id="cloudflare-dns"
        row={0}
        col={3}
        icon="cloudflare"
        tone="amber"
        texture="hatch"
      >
        <Diagram.Line>Cloudflare</Diagram.Line>
        <Diagram.Line>DNS &amp; Domain</Diagram.Line>
        <Diagram.Line>Management</Diagram.Line>
      </Diagram.Box>
      <Diagram.Box
        id="public-internet"
        row={0}
        col={4}
        icon="internet"
        tone="blue"
      >
        Public Internet
      </Diagram.Box>
      <Diagram.Arrow
        from="cloudflare-dns"
        to="public-internet"
        layer="background"
      />
      <Diagram.Connector
        id="cloudflare-tunnel"
        row={1}
        col={4}
        icon="tunnel"
        tone="blue"
        texture="none"
      >
        <Diagram.Line>Cloudflare Tunnel</Diagram.Line>
        <Diagram.Line textColor="dim">(Zero Trust)</Diagram.Line>
      </Diagram.Connector>
      <Diagram.Wire
        from="public-internet"
        to="cloudflare-tunnel"
        layer="background"
        channel="tunnel"
        weight="bold"
      />
      <Diagram.Box id="isp" row={3} col={0} icon="internet" tone="slate">
        <Diagram.Line>ISP Connection</Diagram.Line>
        <Diagram.Line>(1 Gbps)</Diagram.Line>
      </Diagram.Box>
      <Diagram.Appliance
        id="router"
        row={3}
        col={1}
        tone="slate"
        texture="hatch"
        appliancePorts={5}
        antenna
        caption="Fritzbox Router"
        captionSide="bottom"
      />
      <Diagram.Box
        id="adguard"
        row={2}
        col={2}
        icon="shield"
        tone="green"
        texture="hatch"
        caption="DNS Forwarder"
        captionSide="bottom"
      >
        AdGuard Home
      </Diagram.Box>
      <Diagram.Card
        id="laptop"
        row={7}
        col={0}
        colSpan={2}
        icon="server"
        tone="slate"
        texture="hatch"
        items={[
          '32GB RAM',
          '500GB SSD (Internal)',
          'NVIDIA RTX 3050 4GB GPU',
          'CPU 24 Logical Cores',
        ]}
      >
        Dell Laptop
      </Diagram.Card>
      <Diagram.Box
        id="external-ssd"
        row={7}
        col={2}
        icon="storage"
        tone="slate"
        texture="hatch"
      >
        <Diagram.Line>4TB</Diagram.Line>
        <Diagram.Line>External SSD</Diagram.Line>
      </Diagram.Box>
      <Diagram.Group
        id="proxmox"
        label={['Proxmox VE', '(Hypervisor)']}
        titleBand
        tone="amber"
        texture="hatch"
      >
        <Diagram.Card
          id="proxmox-vm"
          row={3}
          col={2}
          rowSpan={2}
          stack={4}
          stackDirection="up-left"
          icon="server"
          tone="amber"
        >
          VM
        </Diagram.Card>
      </Diagram.Group>
      <Diagram.Group
        id="cluster"
        label="K3s Kubernetes Cluster"
        labelAlign="start"
        titleBand
        tone="blue"
        texture="hatch"
      >
        <Diagram.Group
          id="ingress"
          label="Networking & Ingress"
          labelAlign="start"
          titleBand
          tone="blue"
        >
          <Diagram.Box id="metallb" row={2} col={3} icon="router" tone="blue">
            <Diagram.Line>MetalLB</Diagram.Line>
            <Diagram.Line>(Load Balancer)</Diagram.Line>
          </Diagram.Box>
          <Diagram.Box id="gateway" row={2} col={4} icon="shield" tone="blue">
            <Diagram.Line>Istio Ingress Gateway</Diagram.Line>
            <Diagram.Line>(North-South Gateway)</Diagram.Line>
          </Diagram.Box>
        </Diagram.Group>
        <Diagram.Group
          id="certificates"
          label="Certificates"
          titleBand
          tone="slate"
        >
          <Diagram.Box
            id="cert-manager"
            row={2}
            col={5}
            icon="certificate"
            tone="slate"
          >
            Cert-Manager
          </Diagram.Box>
        </Diagram.Group>
        <Diagram.Group
          id="k3s-vms"
          label="K3s"
          titleBand
          tone="green"
          texture="hatch"
        >
          <Diagram.Card
            id="k3s-master"
            row={3}
            col={3}
            icon="kubernetes"
            tone="green"
            texture="hatch"
          >
            <Diagram.Line>K3s master</Diagram.Line>
            <Diagram.Line>Pods</Diagram.Line>
          </Diagram.Card>
        </Diagram.Group>
        <Diagram.Group id="mesh" label="Service Mesh" titleBand tone="blue">
          <Diagram.Card
            id="istio"
            row={3}
            col={4}
            colSpan={2}
            icon="istio"
            tone="blue"
          >
            <Diagram.Line>Istio Service Mesh</Diagram.Line>
            <Diagram.Line textColor="dim">mTLS Enabled</Diagram.Line>
          </Diagram.Card>
        </Diagram.Group>
        <Diagram.Group
          id="storage"
          label="Storage"
          labelAlign="start"
          titleBand
          tone="slate"
        >
          <Diagram.Box
            id="longhorn"
            row={5}
            col={3}
            icon="storage"
            tone="slate"
          >
            <Diagram.Line>Longhorn</Diagram.Line>
            <Diagram.Line>(Storage Class)</Diagram.Line>
          </Diagram.Box>
        </Diagram.Group>
        <Diagram.Group
          id="monitoring"
          label="Monitoring"
          dividers
          titleBand
          tone="amber"
          texture="hatch"
        >
          <Diagram.Box
            id="grafana"
            row={5}
            col={4}
            icon="dashboard"
            tone="amber"
          >
            <Diagram.Line>Grafana</Diagram.Line>
            <Diagram.Line>(Dashboards)</Diagram.Line>
          </Diagram.Box>
          <Diagram.Box
            id="victoria-metrics"
            row={5}
            col={5}
            icon="metrics"
            tone="amber"
          >
            <Diagram.Line>VictoriaMetrics</Diagram.Line>
            <Diagram.Line>(Metrics)</Diagram.Line>
          </Diagram.Box>
          <Diagram.Box
            id="victoria-logs"
            row={6}
            col={4}
            icon="logs"
            tone="amber"
          >
            <Diagram.Line>VictoriaLogs</Diagram.Line>
            <Diagram.Line>(Logs)</Diagram.Line>
          </Diagram.Box>
          <Diagram.Box id="jaeger" row={6} col={5} icon="trace" tone="amber">
            <Diagram.Line>Jaeger</Diagram.Line>
            <Diagram.Line>(Traces)</Diagram.Line>
          </Diagram.Box>
        </Diagram.Group>
        <Diagram.Junction
          id="observability-bus"
          row={4}
          col={4}
          colSpan={2}
          hidden
          tone="blue"
        />
        <Diagram.Box id="argocd" row={4} col={6} icon="git" tone="amber">
          <Diagram.Line>ArgoCD</Diagram.Line>
          <Diagram.Line>(GitOps Deployment)</Diagram.Line>
        </Diagram.Box>
        <Diagram.Note id="argocd-note" row={5} col={6} target="argocd">
          <Diagram.Line>Deploys applications</Diagram.Line>
          <Diagram.Line>into k3s</Diagram.Line>
        </Diagram.Note>
        <Diagram.Group
          id="gpu-scheduling"
          label="GPU Scheduling"
          labelAlign="start"
          titleBand
          tone="green"
          texture="hatch"
        >
          <Diagram.Card
            id="gpu-workflow"
            row={7}
            col={6}
            icon="gpu"
            tone="green"
            texture="hatch"
            description="NVIDIA RTX 3050"
            items={['K3s Node Affinity', 'Automatic GPU Scheduling']}
          >
            GPU Workflow
          </Diagram.Card>
        </Diagram.Group>
        <Diagram.Box id="authentik" row={3} col={6} icon="shield" tone="rose">
          <Diagram.Line>Authentik</Diagram.Line>
          <Diagram.Line>(SSO)</Diagram.Line>
        </Diagram.Box>
      </Diagram.Group>
      <Diagram.Note id="cert-note" row={2} col={7} target="cert-manager">
        <Diagram.Line>Manages</Diagram.Line>
        <Diagram.Line>Let&apos;s Encrypt</Diagram.Line>
        <Diagram.Line>certificates</Diagram.Line>
      </Diagram.Note>
      <Diagram.Marker id="git-repo" row={4} col={7} icon="git" tone="slate">
        Git Repo
      </Diagram.Marker>
      <Diagram.Note id="authentik-note" row={3} col={7} target="authentik">
        <Diagram.Line>Authentication</Diagram.Line>
        <Diagram.Line>for services</Diagram.Line>
        <Diagram.Line>in mesh</Diagram.Line>
      </Diagram.Note>
      <Diagram.Arrow from="isp" to="router" layer="background" />
      {/* The router's caption hangs under it, so its edges leave by the sides. */}
      <Diagram.Arrow
        from="router"
        to="adguard"
        layer="background"
        exitSide="right"
        entrySide="left"
      />
      <Diagram.Arrow
        from="router"
        to="laptop"
        layer="background"
        exitSide="left"
      />
      <Diagram.Arrow from="router" to="proxmox" layer="background" />
      <Diagram.Arrow from="laptop" to="external-ssd" layer="background" />
      <Diagram.Arrow
        from="external-ssd"
        to="longhorn"
        layer="background"
        channel="storage"
        lineStyle="dashed"
      >
        Distributed Storage &amp; Backups
      </Diagram.Arrow>
      <Diagram.Arrow
        from="argocd"
        to="istio"
        layer="background"
        channel="deploy"
        labelFrame
      >
        Deploys
      </Diagram.Arrow>
      <Diagram.Arrow
        from="git-repo"
        to="argocd"
        layer="background"
        channel="gitops"
        lineStyle="dashed"
      >
        <Diagram.Line>Continuous deployment</Diagram.Line>
        <Diagram.Line>requests</Diagram.Line>
      </Diagram.Arrow>
      <Diagram.Arrow
        from="longhorn"
        to="istio"
        layer="background"
        channel="storage"
      />
      <Diagram.Arrow
        from="grafana"
        to="observability-bus"
        layer="background"
        channel="observability"
        headless
      />
      <Diagram.Arrow
        from="victoria-metrics"
        to="observability-bus"
        layer="background"
        channel="observability"
        headless
      />
      <Diagram.Arrow
        from="victoria-logs"
        to="observability-bus"
        layer="background"
        channel="observability"
        headless
      />
      <Diagram.Arrow
        from="jaeger"
        to="observability-bus"
        layer="background"
        channel="observability"
        headless
      />
      <Diagram.Arrow
        from="observability-bus"
        to="istio"
        layer="background"
        channel="observability"
      />
      <Diagram.Arrow
        from="gpu-scheduling"
        to="istio"
        layer="background"
        channel="gpu"
      />
      <Diagram.Arrow from="proxmox" to="k3s-master" layer="background" />
      <Diagram.Arrow
        from="cloudflare-tunnel"
        to="gateway"
        layer="background"
        channel="tunnel"
        weight="bold"
      />
      <Diagram.Arrow from="metallb" to="gateway" layer="background" labelFrame>
        External IPs
      </Diagram.Arrow>
      <Diagram.Arrow
        from="cert-manager"
        to="gateway"
        layer="background"
        channel="certificates"
        lineStyle="dashed"
        labelFrame
      >
        certificates
      </Diagram.Arrow>
      <Diagram.Arrow
        from="gateway"
        to="istio"
        layer="background"
        channel="mtls"
        direction="both"
      />
      <Diagram.Arrow
        from="k3s-master"
        to="istio"
        layer="background"
        channel="mtls"
      />
      <Diagram.Arrow
        from="authentik"
        to="istio"
        layer="background"
        channel="auth"
        labelFrame
      >
        SSO
      </Diagram.Arrow>
    </SvgGraphDiagram>
  );
}
