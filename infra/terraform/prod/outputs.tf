output "host" {
  description = "Static public IPv4 address of the Riff host"
  value       = aws_lightsail_static_ip.host.ip_address
}

output "base_domain" {
  description = "Free wildcard domain that resolves to the static IP"
  value       = "${replace(aws_lightsail_static_ip.host.ip_address, ".", "-")}.sslip.io"
}

output "streamers" {
  value = var.streamers
}

output "console_urls" {
  value = {
    for name in var.streamers :
    name => "https://${name}.${replace(aws_lightsail_static_ip.host.ip_address, ".", "-")}.sslip.io"
  }
}
